/**
 * Debug Session Manager
 *
 * Orchestrates debug sessions, manages the XDebug connection,
 * and coordinates between tools. This is the central coordinator
 * for all debugging operations.
 *
 * @packageDocumentation
 * @module debug/session-manager
 *
 * Copyright 2026 Tyler Wall
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { getConfig } from '../config.js';
import {
  NoActiveSessionError,
  SessionAlreadyActiveError,
  SessionNotPausedError,
  SessionStoppedError,
  NotConnectedError,
} from '../errors.js';
import type {
  SessionState,
  SessionStatus,
  BreakpointConfig,
  DebugLocation,
  DebugSessionConfig,
  ExecutionAction,
  VariableInfo,
} from '../types/index.js';
import { DbgpConnection, BreakEventData } from './dbgp-connection.js';
import { PathMapper } from './path-mapper.js';
import { SessionRecorder } from './session-recorder.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('session-manager');

/**
 * Manages debug sessions and coordinates all debugging operations
 */
export class DebugSessionManager {
  private session: SessionState | null = null;
  private connection: DbgpConnection | null = null;
  private pathMapper: PathMapper;
  private recorder: SessionRecorder;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private stepCount = 0;
  private isShuttingDown = false;

  private mappingsLoaded = false;

  constructor() {
    this.pathMapper = new PathMapper();
    this.recorder = new SessionRecorder();

    // Handle process signals for cleanup
    this.setupSignalHandlers();

    // Load path mappings eagerly (async, but will be ready before most operations)
    this.ensureMappingsLoaded();
  }

  /**
   * Ensure path mappings are loaded (idempotent)
   */
  private async ensureMappingsLoaded(): Promise<void> {
    if (!this.mappingsLoaded) {
      await this.pathMapper.loadMappings();
      this.mappingsLoaded = true;
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Start a new debug session
   *
   * @param config - Session configuration
   * @returns The session state
   * @throws {SessionAlreadyActiveError} If a session is already running
   */
  async startSession(config: DebugSessionConfig): Promise<SessionState> {
    // Check for existing ACTIVE session (connected or running)
    // Allow reusing "pending" sessions (created by setBreakpoint)
    const isPendingSession =
      this.session?.status === 'initializing' && this.session?.id === 'pending';
    if (this.session && !this.isSessionEnded() && !isPendingSession) {
      throw new SessionAlreadyActiveError();
    }

    const sessionId = randomUUID();
    logger.info('Starting session', { sessionId, command: config.command });

    // Preserve breakpoints from pending session if any
    const existingBreakpoints = this.session?.breakpoints ?? new Map();

    // Initialize session state (preserving breakpoints)
    this.session = {
      id: sessionId,
      status: 'initializing',
      breakpoints: existingBreakpoints,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    };
    this.stepCount = 0;

    try {
      // Load path mappings
      await this.pathMapper.loadMappings(config.pathMappings);

      // Initialize recorder
      await this.recorder.initSession(sessionId);

      // Create DBGp connection
      const globalConfig = getConfig();
      this.connection = new DbgpConnection({
        port: config.port ?? globalConfig.port,
        timeout: config.timeout ?? globalConfig.connectionTimeout,
      });

      // Set up event handlers
      this.setupConnectionHandlers();

      // Start listening
      await this.connection.listen();
      this.updateStatus('listening');

      // Execute trigger command (async - starts curl in background)
      await this.connection.executeTrigger(
        config.command,
        config.workingDirectory
      );

      // Wait for XDebug to connect
      const timeout = config.timeout ?? globalConfig.connectionTimeout;
      await this.connection.waitForConnection(timeout);
      this.updateStatus('connected');

      // Now that we're connected, set breakpoints
      await this.setAllBreakpoints();

      // Configure stop-on behaviors
      if (config.stopOnException) {
        await this.connection.breakOnException('*');
      }

      // Start watchdog timer
      this.startWatchdog();

      // If stop_on_entry, step into first line; otherwise run until breakpoint
      if (config.stopOnEntry) {
        await this.connection.stepInto();
      } else {
        await this.connection.run();
      }

      // Wait for break event (breakpoint hit, step complete, or exception)
      this.updateStatus('running');
      try {
        await this.connection.waitForBreak(5000);
      } catch {
        // No break within timeout - execution may have completed
        logger.debug('No break event within timeout');
      }

      return this.session;
    } catch (error) {
      this.session.status = 'error';
      this.session.errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error('Failed to start session', { error });
      throw error;
    }
  }

  /**
   * Set a breakpoint
   *
   * @param config - Breakpoint configuration
   * @returns The breakpoint config with ID if registered
   */
  async setBreakpoint(config: BreakpointConfig): Promise<BreakpointConfig> {
    // Ensure path mappings are loaded before resolving paths
    await this.ensureMappingsLoaded();

    // Create pending session for breakpoint storage if needed
    if (!this.session) {
      this.session = {
        id: 'pending',
        status: 'initializing',
        breakpoints: new Map(),
        startedAt: new Date(),
        lastActivityAt: new Date(),
      };
    }

    const key = `${config.file}:${config.line}`;

    // Translate to remote path for storage
    const remotePath = this.pathMapper.toRemote(config.file);
    const storedConfig: BreakpointConfig = {
      ...config,
      file: remotePath,
      enabled: true,
    };

    this.session.breakpoints.set(key, storedConfig);

    // If connected, set immediately
    if (this.connection?.isConnected()) {
      try {
        const result = await this.connection.setBreakpoint({
          type: 'line',
          filename: remotePath,
          lineno: config.line,
          expression: config.condition,
        });
        storedConfig.id = result.id;
      } catch (error) {
        logger.warn('Failed to set breakpoint', { error, file: config.file, line: config.line });
      }
    }

    logger.info('Breakpoint set', {
      file: config.file,
      remotePath,
      line: config.line,
      condition: config.condition,
    });

    // Return both local file and resolved remote path
    return { ...config, id: storedConfig.id, remotePath };
  }

  /**
   * Remove a breakpoint
   *
   * @param file - File path
   * @param line - Line number
   */
  async removeBreakpoint(file: string, line: number): Promise<void> {
    if (!this.session) return;

    const key = `${file}:${line}`;
    const bp = this.session.breakpoints.get(key);

    if (bp?.id && this.connection?.isConnected()) {
      try {
        await this.connection.removeBreakpoint(bp.id);
      } catch (error) {
        logger.warn('Failed to remove breakpoint', { error });
      }
    }

    this.session.breakpoints.delete(key);
  }

  /**
   * Inspect a variable
   *
   * @param name - Variable name (e.g., '$this', '$request')
   * @param depth - Recursion depth (default: 1, max: config.maxDepth)
   * @param maxChildren - Max children to return
   * @returns Variable info or null if not found
   */
  async inspectVariable(
    name: string,
    depth: number = 1,
    maxChildren?: number
  ): Promise<VariableInfo | null> {
    this.requireSession();
    this.requirePaused();
    this.resetWatchdog();

    if (!this.connection) {
      throw new NotConnectedError();
    }

    const config = getConfig();
    const actualDepth = Math.min(depth, config.maxDepth);
    const actualMaxChildren = maxChildren ?? config.defaultMaxChildren;

    const result = await this.connection.getProperty(
      name,
      actualDepth,
      actualMaxChildren
    );

    // Record to history for time-travel debugging
    if (result && this.session?.location) {
      await this.recorder.recordVariable(
        this.session.id,
        this.stepCount,
        this.session.location,
        name,
        result
      );
    }

    return result;
  }

  /**
   * Execute a debug action
   *
   * @param action - Action to perform
   * @returns Updated session state
   */
  async executeAction(action: ExecutionAction): Promise<SessionState> {
    this.requireSession();
    this.resetWatchdog();

    if (action === 'stop') {
      await this.stopSession();
      return this.session!;
    }

    if (!this.connection?.isConnected()) {
      throw new NotConnectedError();
    }

    logger.info('Executing action', { action });

    // Map to DBGp commands
    const commandMap: Record<Exclude<ExecutionAction, 'stop'>, string> = {
      step_over: 'step_over',
      step_into: 'step_into',
      step_out: 'step_out',
      continue: 'run',
    };

    this.updateStatus('running');
    await this.connection.sendCommand(commandMap[action]);

    // Wait for break or completion
    try {
      await this.connection.waitForBreak();
    } catch (error) {
      // Session may have ended
      if (!this.connection.isConnected()) {
        this.updateStatus('stopped');
      }
    }

    return this.session!;
  }

  /**
   * Query variable history (time-travel debugging)
   *
   * @param variableName - Variable to query
   * @param stepsAgo - How many steps back to look
   * @param limit - Max entries to return
   */
  async getHistory(
    variableName: string,
    stepsAgo: number = 1,
    limit: number = 5
  ): Promise<unknown[]> {
    this.requireSession();

    return this.recorder.getVariableHistory(
      this.session!.id,
      variableName,
      this.stepCount - stepsAgo,
      limit
    );
  }

  /**
   * Get current session state
   */
  getSession(): SessionState | null {
    return this.session;
  }

  /**
   * Get current step count
   */
  getStepCount(): number {
    return this.stepCount;
  }

  /**
   * Stop the current session and clean up
   */
  async stopSession(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Stopping session');

    this.stopWatchdog();

    // Send stop command if connected
    if (this.connection?.isConnected()) {
      try {
        await this.connection.sendCommand('stop');
      } catch {
        // Ignore errors during stop
      }
    }

    // Close connection
    this.connection?.close();
    this.connection = null;

    // Finalize session
    if (this.session && this.session.id !== 'pending') {
      this.session.status = 'stopped';
      await this.recorder.finalizeSession(this.session.id);
    }

    this.isShuttingDown = false;
  }

  /**
   * Clean shutdown of all resources
   */
  async shutdown(): Promise<void> {
    await this.stopSession();
    this.recorder.close();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private setupConnectionHandlers(): void {
    if (!this.connection) return;

    this.connection.on('connected', () => {
      this.updateStatus('connected');
    });

    this.connection.on('break', async (data: BreakEventData) => {
      await this.handleBreak(data);
    });

    this.connection.on('error', (error) => {
      logger.error('Connection error', { error: error.message });
      if (this.session) {
        this.session.status = 'error';
        this.session.errorMessage = error.message;
      }
    });

    this.connection.on('close', () => {
      this.updateStatus('stopped');
      this.stopWatchdog();
    });
  }

  private async handleBreak(data: BreakEventData): Promise<void> {
    this.stepCount++;

    const localFile = this.pathMapper.toLocal(data.filename);

    const location: DebugLocation = {
      file: localFile,
      line: data.lineno,
    };

    // Get stack for function context
    if (this.connection?.isConnected()) {
      try {
        const stack = await this.connection.getStackFrames();
        if (stack.length > 0 && stack[0]) {
          location.function = stack[0].where;
        }
      } catch {
        // Non-critical
      }
    }

    // Read code snippet
    let codeSnippet: string | undefined;
    try {
      codeSnippet = await this.readCodeSnippet(localFile, data.lineno);
    } catch {
      // File might not be accessible
    }

    // Update session state
    if (this.session) {
      this.session.status = 'paused';
      this.session.location = location;
      this.session.codeSnippet = codeSnippet;
      this.session.pauseReason = data.reason;
      this.session.lastActivityAt = new Date();
    }

    // Record step
    await this.recorder.recordStep(
      this.session!.id,
      this.stepCount,
      location,
      data.reason
    );

    logger.info('Break hit', {
      file: localFile,
      line: data.lineno,
      reason: data.reason,
      stepCount: this.stepCount,
    });

    this.resetWatchdog();
  }

  private async readCodeSnippet(
    file: string,
    line: number,
    context: number = 3
  ): Promise<string> {
    const content = await readFile(file, 'utf-8');
    const lines = content.split('\n');

    const start = Math.max(0, line - context - 1);
    const end = Math.min(lines.length, line + context);

    return lines
      .slice(start, end)
      .map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === line ? '→' : ' ';
        return `${marker}${lineNum.toString().padStart(4)} │ ${l}`;
      })
      .join('\n');
  }

  private async setAllBreakpoints(): Promise<void> {
    if (!this.connection || !this.session) return;

    for (const [, bp] of this.session.breakpoints) {
      try {
        const result = await this.connection.setBreakpoint({
          type: 'line',
          filename: bp.file,
          lineno: bp.line,
          expression: bp.condition,
        });
        bp.id = result.id;
      } catch (error) {
        logger.warn('Failed to set breakpoint', { error, bp });
      }
    }
  }

  private updateStatus(status: SessionStatus): void {
    if (this.session) {
      this.session.status = status;
      this.session.lastActivityAt = new Date();
    }
  }

  private isSessionEnded(): boolean {
    return (
      !this.session ||
      this.session.status === 'stopped' ||
      this.session.status === 'error'
    );
  }

  private requireSession(): SessionState {
    if (!this.session) {
      throw new NoActiveSessionError();
    }
    if (this.session.status === 'stopped') {
      throw new SessionStoppedError();
    }
    return this.session;
  }

  private requirePaused(): void {
    if (this.session?.status !== 'paused') {
      throw new SessionNotPausedError();
    }
  }

  // ==========================================================================
  // Watchdog Timer
  // ==========================================================================

  private startWatchdog(): void {
    this.stopWatchdog();

    const timeout = getConfig().watchdogTimeout;
    this.watchdogTimer = setTimeout(() => {
      logger.warn('Watchdog timeout - terminating idle session', {
        timeout,
        sessionId: this.session?.id,
      });
      this.stopSession().catch(() => {});
    }, timeout);
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) {
      this.startWatchdog();
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // ==========================================================================
  // Signal Handlers
  // ==========================================================================

  private setupSignalHandlers(): void {
    const cleanup = async () => {
      await this.shutdown();
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('beforeExit', cleanup);
  }
}
