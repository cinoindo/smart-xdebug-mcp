/**
 * DBGp Protocol Connection Handler
 *
 * Implements the DBGp debugging protocol used by XDebug.
 * Reference: https://xdebug.org/docs/dbgp
 *
 * @packageDocumentation
 * @module debug/dbgp-connection
 *
 * Copyright 2026 Tyler Wall
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Server, Socket } from 'net';
import { createServer } from 'net';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { XMLParser } from 'fast-xml-parser';
import { getConfig } from '../config.js';
import {
  ConnectionTimeoutError,
  NoAvailablePortError,
  NotConnectedError,
  DbgpError,
} from '../errors.js';
import type { VariableInfo, StackFrame, PauseReason } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('dbgp');

// ============================================================================
// Types
// ============================================================================

/** Configuration for DBGp connection */
export interface DbgpConnectionConfig {
  /** Starting port to try */
  port: number;
  /** End of port range for auto-discovery */
  portRangeEnd: number;
  /** Command timeout in milliseconds */
  timeout: number;
}

/** Parameters for setting a breakpoint */
export interface BreakpointParams {
  type: 'line' | 'call' | 'return' | 'exception' | 'conditional';
  filename?: string;
  lineno?: number;
  function?: string;
  exception?: string;
  expression?: string;
}

/** Data emitted on break event */
export interface BreakEventData {
  filename: string;
  lineno: number;
  reason: PauseReason;
  exception?: {
    name: string;
    message: string;
  };
}

// Internal XML parsing types
interface ParsedResponse {
  init?: {
    '@_fileuri': string;
    '@_language': string;
    '@_protocol_version': string;
    '@_appid': string;
    '@_idekey': string;
  };
  response?: {
    '@_command': string;
    '@_transaction_id': string;
    '@_status'?: string;
    '@_reason'?: string;
    '@_success'?: string;
    '@_id'?: string;
    '@_filename'?: string;
    '@_lineno'?: string;
    message?: {
      '@_filename': string;
      '@_lineno': string;
      '@_exception': string;
      '#text'?: string;
    };
    property?: DbgpProperty | DbgpProperty[];
    stack?: DbgpStack | DbgpStack[];
    error?: {
      '@_code': string;
      message: string;
    };
  };
}

interface DbgpProperty {
  '@_name': string;
  '@_fullname'?: string;
  '@_type': string;
  '@_classname'?: string;
  '@_numchildren'?: string;
  '@_size'?: string;
  '@_encoding'?: string;
  '#text'?: string;
  property?: DbgpProperty | DbgpProperty[];
}

interface DbgpStack {
  '@_level': string;
  '@_type': string;
  '@_filename': string;
  '@_lineno': string;
  '@_where'?: string;
  '@_cmdbegin'?: string;
}

// ============================================================================
// Events Interface
// ============================================================================

export interface DbgpConnectionEvents {
  connected: () => void;
  break: (data: BreakEventData) => void;
  error: (error: Error) => void;
  close: () => void;
}

// ============================================================================
// DBGp Connection Class
// ============================================================================

/**
 * Manages the DBGp protocol connection to XDebug
 */
export class DbgpConnection extends EventEmitter {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private triggerProcess: ChildProcess | null = null;
  private readonly xmlParser: XMLParser;
  private transactionId = 0;
  private readonly pendingCommands = new Map<
    string,
    {
      resolve: (value: ParsedResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer = '';
  private config: DbgpConnectionConfig;
  private actualPort: number;
  private connected = false;
  private connectionResolve: (() => void) | null = null;
  private breakResolve: (() => void) | null = null;
  private isClosing = false;

  constructor(config: Partial<DbgpConnectionConfig> = {}) {
    super();
    const globalConfig = getConfig();
    this.config = {
      port: config.port ?? globalConfig.port,
      portRangeEnd: config.portRangeEnd ?? globalConfig.portRangeEnd,
      timeout: config.timeout ?? globalConfig.connectionTimeout,
    };
    this.actualPort = this.config.port;

    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Start listening for XDebug connections
   */
  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.tryListenOnPort(this.config.port, resolve, reject);
    });
  }

  private tryListenOnPort(
    port: number,
    resolve: (port: number) => void,
    reject: (error: Error) => void
  ): void {
    if (port > this.config.portRangeEnd) {
      reject(new NoAvailablePortError(this.config.port, this.config.portRangeEnd));
      return;
    }

    const server = createServer((socket) => {
      this.handleConnection(socket);
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.debug('Port busy, trying next', { port, nextPort: port + 1 });
        server.close();
        this.tryListenOnPort(port + 1, resolve, reject);
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      this.server = server;
      this.actualPort = port;
      logger.info('Listening for XDebug', { port });
      resolve(port);
    });
  }

  /**
   * Get the port the server is listening on
   */
  getPort(): number {
    return this.actualPort;
  }

  /**
   * Wait for XDebug to connect
   */
  async waitForConnection(timeout?: number): Promise<void> {
    if (this.connected) {
      return;
    }

    const timeoutMs = timeout ?? this.config.timeout;

    return new Promise((resolve, reject) => {
      this.connectionResolve = resolve;

      const timer = setTimeout(() => {
        this.connectionResolve = null;
        reject(new ConnectionTimeoutError(timeoutMs));
      }, timeoutMs);

      // Clean up timer when resolved
      const originalResolve = this.connectionResolve;
      this.connectionResolve = () => {
        clearTimeout(timer);
        originalResolve();
      };
    });
  }

  /**
   * Execute the trigger command to initiate PHP execution
   */
  async executeTrigger(command: string, workingDirectory?: string): Promise<void> {
    logger.info('Executing trigger', { command });

    // Validate command
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      throw new Error('Trigger command cannot be empty');
    }

    // Set XDebug environment variables
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDEBUG_CONFIG: `client_host=host.docker.internal client_port=${this.actualPort}`,
      XDEBUG_SESSION: 'mcp',
      XDEBUG_MODE: 'debug',
      XDEBUG_TRIGGER: 'yes',
    };

    // Parse command - handle quoted arguments properly
    const parts = this.parseCommand(trimmedCommand);
    const [cmd, ...args] = parts;

    if (!cmd) {
      throw new Error('Invalid trigger command');
    }

    // Security: Don't use shell: true to prevent command injection.
    // Complex commands (pipes, redirects) should use a wrapper script.
    this.triggerProcess = spawn(cmd, args, {
      cwd: workingDirectory ?? process.cwd(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    // Log output for debugging
    this.triggerProcess.stdout?.on('data', (data: Buffer) => {
      logger.debug('Trigger stdout', { data: data.toString().slice(0, 500) });
    });

    this.triggerProcess.stderr?.on('data', (data: Buffer) => {
      logger.debug('Trigger stderr', { data: data.toString().slice(0, 500) });
    });

    this.triggerProcess.on('error', (error) => {
      logger.error('Trigger process error', { error });
    });

    this.triggerProcess.on('exit', (code, signal) => {
      logger.info('Trigger exited', { code, signal });
      this.triggerProcess = null;
    });

    // Unref to allow parent to exit independently
    this.triggerProcess.unref();
  }

  /**
   * Wait for execution to break (hit breakpoint or exception)
   */
  async waitForBreak(timeout?: number): Promise<void> {
    const timeoutMs = timeout ?? this.config.timeout * 2; // Allow longer for execution

    return new Promise((resolve, reject) => {
      this.breakResolve = resolve;

      const timer = setTimeout(() => {
        this.breakResolve = null;
        reject(new Error('Timeout waiting for break'));
      }, timeoutMs);

      const originalResolve = this.breakResolve;
      this.breakResolve = () => {
        clearTimeout(timer);
        originalResolve();
      };
    });
  }

  /**
   * Send a DBGp command
   */
  async sendCommand(command: string, args?: string): Promise<ParsedResponse> {
    if (!this.socket || !this.connected) {
      throw new NotConnectedError();
    }

    const transactionId = String(++this.transactionId);
    const fullCommand = args
      ? `${command} -i ${transactionId} ${args}`
      : `${command} -i ${transactionId}`;

    logger.debug('Sending command', { command: fullCommand.slice(0, 200) });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(transactionId);
        reject(new Error(`Command timeout: ${command}`));
      }, this.config.timeout);

      this.pendingCommands.set(transactionId, { resolve, reject, timer });

      this.socket!.write(fullCommand + '\0', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingCommands.delete(transactionId);
          reject(err);
        }
      });
    });
  }

  /**
   * Set a DBGp feature
   */
  async setFeature(name: string, value: string): Promise<boolean> {
    const response = await this.sendCommand('feature_set', `-n ${name} -v ${value}`);
    return response.response?.['@_success'] === '1';
  }

  /**
   * Configure breaking on exceptions
   */
  async breakOnException(exception: string): Promise<void> {
    await this.sendCommand('breakpoint_set', `-t exception -x ${exception}`);
  }

  /**
   * Set a breakpoint
   */
  async setBreakpoint(params: BreakpointParams): Promise<{ id: number }> {
    let args = `-t ${params.type}`;

    if (params.filename) {
      // Ensure file URI format
      const fileUri = params.filename.startsWith('file://')
        ? params.filename
        : `file://${encodeURI(params.filename)}`;
      args += ` -f ${fileUri}`;
    }
    if (params.lineno !== undefined) {
      args += ` -n ${params.lineno}`;
    }
    if (params.function) {
      args += ` -m ${params.function}`;
    }
    if (params.exception) {
      args += ` -x ${params.exception}`;
    }
    if (params.expression) {
      const encoded = Buffer.from(params.expression).toString('base64');
      args += ` -- ${encoded}`;
    }

    const response = await this.sendCommand('breakpoint_set', args);

    if (response.response?.error) {
      throw new DbgpError(
        response.response.error.message,
        response.response.error['@_code']
      );
    }

    const id = parseInt(response.response?.['@_id'] ?? '0', 10);
    return { id };
  }

  /**
   * Remove a breakpoint
   */
  async removeBreakpoint(id: number): Promise<void> {
    await this.sendCommand('breakpoint_remove', `-d ${id}`);
  }

  /**
   * Continue execution until next breakpoint
   */
  async run(): Promise<void> {
    await this.sendCommand('run');
  }

  /**
   * Step into the next statement
   */
  async stepInto(): Promise<void> {
    await this.sendCommand('step_into');
  }

  /**
   * Step over the current statement
   */
  async stepOver(): Promise<void> {
    await this.sendCommand('step_over');
  }

  /**
   * Step out of the current function
   */
  async stepOut(): Promise<void> {
    await this.sendCommand('step_out');
  }

  /**
   * Get a variable/property value
   *
   * @param name - Variable name (e.g., '$this', '$request')
   * @param maxDepth - Max recursion depth for nested properties (1-3)
   * @param maxChildren - Max children to return per property
   * @param stackDepth - Stack frame depth (0 = current frame)
   */
  async getProperty(
    name: string,
    maxDepth: number = 1,
    maxChildren: number = 20,
    stackDepth: number = 0
  ): Promise<VariableInfo | null> {
    try {
      // Set max_depth and max_children features before fetching
      // These affect how much data XDebug returns for nested properties
      await this.setFeature('max_depth', String(maxDepth));
      await this.setFeature('max_children', String(maxChildren));

      // property_get -n name -d stack_depth -c context_id
      // -d: Stack depth (0 = current frame)
      // -c: Context id (0 = local, 1 = superglobals)
      const response = await this.sendCommand(
        'property_get',
        `-n ${name} -d ${stackDepth} -c 0`
      );

      if (response.response?.error) {
        // Error code 300 = property not found
        if (response.response.error['@_code'] === '300') {
          return null;
        }
        throw new DbgpError(
          response.response.error.message,
          response.response.error['@_code']
        );
      }

      const property = response.response?.property;
      if (!property) {
        return null;
      }

      return this.parseProperty(Array.isArray(property) ? property[0]! : property);
    } catch (error) {
      // Handle property not found gracefully
      if (error instanceof DbgpError && error.dbgpCode === '300') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get all context variables (local, global, etc.)
   */
  async getContextVariables(
    contextId: number = 0,
    depth: number = 1
  ): Promise<VariableInfo[]> {
    const response = await this.sendCommand(
      'context_get',
      `-c ${contextId} -d ${depth}`
    );

    const property = response.response?.property;
    if (!property) {
      return [];
    }

    const properties = Array.isArray(property) ? property : [property];
    return properties.map((p) => this.parseProperty(p));
  }

  /**
   * Get the call stack
   */
  async getStackFrames(): Promise<StackFrame[]> {
    const response = await this.sendCommand('stack_get');
    const stack = response.response?.stack;

    if (!stack) {
      return [];
    }

    const frames = Array.isArray(stack) ? stack : [stack];
    return frames.map((f) => ({
      level: parseInt(f['@_level'], 10),
      type: f['@_type'] as 'file' | 'eval',
      filename: this.decodeFileUri(f['@_filename']),
      lineno: parseInt(f['@_lineno'], 10),
      where: f['@_where'],
      cmdbegin: f['@_cmdbegin'],
    }));
  }

  /**
   * Evaluate a PHP expression
   */
  async evaluate(expression: string): Promise<VariableInfo | null> {
    const encoded = Buffer.from(expression).toString('base64');
    const response = await this.sendCommand('eval', `-- ${encoded}`);

    const property = response.response?.property;
    if (!property) {
      return null;
    }

    return this.parseProperty(Array.isArray(property) ? property[0]! : property);
  }

  /**
   * Check if connected to XDebug
   */
  isConnected(): boolean {
    return this.connected && this.socket !== null;
  }

  /**
   * Close the connection and clean up
   */
  close(): void {
    if (this.isClosing) {
      return;
    }
    this.isClosing = true;

    logger.info('Closing connection');

    // Kill trigger process
    if (this.triggerProcess) {
      try {
        this.triggerProcess.kill('SIGTERM');
      } catch {
        // Ignore errors
      }
      this.triggerProcess = null;
    }

    // Clear pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingCommands.delete(id);
    }

    // Close socket
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.connected = false;
    this.isClosing = false;
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  override on<K extends keyof DbgpConnectionEvents>(
    event: K,
    listener: DbgpConnectionEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof DbgpConnectionEvents>(
    event: K,
    ...args: Parameters<DbgpConnectionEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private handleConnection(socket: Socket): void {
    logger.info('XDebug connected');

    this.socket = socket;
    this.connected = true;
    this.buffer = '';

    socket.on('data', (data) => {
      this.handleData(data);
    });

    socket.on('close', () => {
      logger.info('XDebug disconnected');
      this.connected = false;
      this.emit('close');
    });

    socket.on('error', (err) => {
      logger.error('Socket error', { error: err });
      this.emit('error', err);
    });

    // Resolve pending connection wait
    if (this.connectionResolve) {
      this.connectionResolve();
      this.connectionResolve = null;
    }

    this.emit('connected');
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // DBGp message format: length\0xml\0
    while (this.buffer.length > 0) {
      const nullIndex = this.buffer.indexOf('\0');
      if (nullIndex === -1) {
        break;
      }

      const lengthStr = this.buffer.slice(0, nullIndex);
      const length = parseInt(lengthStr, 10);

      if (isNaN(length) || length <= 0) {
        // Malformed message, try to recover
        logger.warn('Malformed message length', { lengthStr });
        this.buffer = this.buffer.slice(nullIndex + 1);
        continue;
      }

      const messageStart = nullIndex + 1;
      const messageEnd = messageStart + length;
      const expectedTotal = messageEnd + 1; // +1 for trailing null

      if (this.buffer.length < expectedTotal) {
        // Incomplete message, wait for more data
        break;
      }

      const xml = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(expectedTotal);

      this.handleMessage(xml);
    }
  }

  private handleMessage(xml: string): void {
    try {
      const parsed = this.xmlParser.parse(xml) as ParsedResponse;
      logger.debug('Received message', { xml: xml.slice(0, 300) });

      // Handle init packet
      if (parsed.init) {
        logger.info('XDebug initialized', {
          fileuri: parsed.init['@_fileuri'],
          idekey: parsed.init['@_idekey'],
          language: parsed.init['@_language'],
        });
        return;
      }

      // Handle response
      if (parsed.response) {
        this.handleResponse(parsed);
      }
    } catch (err) {
      logger.error('XML parse error', {
        error: err,
        xml: xml.slice(0, 200),
      });
    }
  }

  private handleResponse(parsed: ParsedResponse): void {
    const response = parsed.response!;
    const transactionId = response['@_transaction_id'];

    // Check for break status
    if (response['@_status'] === 'break') {
      const reason = this.mapReason(response['@_reason']);
      const filename =
        response['@_filename'] ?? response.message?.['@_filename'] ?? '';
      const lineno = parseInt(
        response['@_lineno'] ?? response.message?.['@_lineno'] ?? '0',
        10
      );

      const breakData: BreakEventData = {
        filename: this.decodeFileUri(filename),
        lineno,
        reason,
        exception: response.message
          ? {
              name: response.message['@_exception'],
              message: response.message['#text'] ?? '',
            }
          : undefined,
      };

      this.emit('break', breakData);

      if (this.breakResolve) {
        this.breakResolve();
        this.breakResolve = null;
      }
    }

    // Check for stopped status
    if (response['@_status'] === 'stopped') {
      logger.info('Debug session stopped');
      this.emit('close');
    }

    // Resolve pending command
    const pending = this.pendingCommands.get(transactionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(transactionId);

      if (response.error) {
        pending.reject(
          new DbgpError(response.error.message, response.error['@_code'])
        );
      } else {
        pending.resolve(parsed);
      }
    }
  }

  private mapReason(reason?: string): PauseReason {
    switch (reason) {
      case 'ok':
        return 'step_complete';
      case 'error':
      case 'exception':
        return 'exception';
      default:
        return 'breakpoint_hit';
    }
  }

  private decodeFileUri(uri: string): string {
    if (!uri) return '';

    // Handle file:// URIs
    if (uri.startsWith('file://')) {
      try {
        return decodeURIComponent(uri.slice(7));
      } catch {
        return uri.slice(7);
      }
    }
    return uri;
  }

  private parseProperty(prop: DbgpProperty): VariableInfo {
    const info: VariableInfo = {
      name: prop['@_name'],
      type: prop['@_type'],
      fullname: prop['@_fullname'],
      classname: prop['@_classname'],
      numchildren: prop['@_numchildren']
        ? parseInt(prop['@_numchildren'], 10)
        : undefined,
    };

    // Decode value based on encoding
    if (prop['#text']) {
      const encoding = prop['@_encoding'];
      if (encoding === 'base64') {
        try {
          const decoded = Buffer.from(prop['#text'], 'base64').toString('utf-8');
          info.value = this.parseValue(info.type, decoded);
        } catch {
          info.value = prop['#text'];
        }
      } else {
        info.value = this.parseValue(info.type, prop['#text']);
      }
    }

    // Check for truncation
    if (prop['@_size']) {
      const size = parseInt(prop['@_size'], 10);
      const actualSize = String(info.value ?? '').length;
      if (size > actualSize) {
        info.truncated = true;
      }
    }

    // Parse children recursively
    if (prop.property) {
      const children = Array.isArray(prop.property)
        ? prop.property
        : [prop.property];
      info.children = children.map((c) => this.parseProperty(c));
    }

    return info;
  }

  private parseValue(type: string, value: unknown): unknown {
    // Ensure value is a string for parsing
    const strValue = typeof value === 'string' ? value : String(value ?? '');

    switch (type) {
      case 'int':
        return parseInt(strValue, 10);
      case 'float':
        return parseFloat(strValue);
      case 'bool':
        return strValue === '1' || strValue.toLowerCase() === 'true';
      case 'null':
        return null;
      case 'resource':
        return `[resource: ${strValue}]`;
      default:
        return strValue;
    }
  }

  private parseCommand(command: string): string[] {
    // Simple command parsing - handles basic quoting
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const char of command) {
      if (!inQuote && (char === '"' || char === "'")) {
        inQuote = true;
        quoteChar = char;
      } else if (inQuote && char === quoteChar) {
        inQuote = false;
        quoteChar = '';
      } else if (!inQuote && char === ' ') {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      parts.push(current);
    }

    return parts;
  }
}
