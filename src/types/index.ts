/**
 * Core type definitions for Smart XDebug MCP
 *
 * @packageDocumentation
 * @module types
 *
 * Copyright 2026 Tyler Wall
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================================================
// Path Mapping
// ============================================================================

/**
 * Mapping between local (host) and remote (container) paths
 */
export interface PathMapping {
  /** Local filesystem path (host machine) */
  local: string;
  /** Remote filesystem path (container/server) */
  remote: string;
}

// ============================================================================
// Breakpoints
// ============================================================================

/**
 * Breakpoint configuration
 */
export interface BreakpointConfig {
  /** File path (local format) */
  file: string;
  /** Line number */
  line: number;
  /** Optional conditional expression (PHP code) */
  condition?: string;
  /** XDebug-assigned breakpoint ID (set after registration) */
  id?: number;
  /** Whether this breakpoint is enabled */
  enabled?: boolean;
  /** Resolved remote path (in container) - set after path mapping */
  remotePath?: string;
}

/**
 * Breakpoint types supported by DBGp
 */
export type BreakpointType =
  | 'line'
  | 'call'
  | 'return'
  | 'exception'
  | 'conditional'
  | 'watch';

// ============================================================================
// Debug Location
// ============================================================================

/**
 * Location in source code where debugger is paused
 */
export interface DebugLocation {
  /** File path (local format) */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Function name if inside a function */
  function?: string;
  /** Class name if inside a class method */
  class?: string;
}

// ============================================================================
// Session Configuration
// ============================================================================

/**
 * Configuration for starting a debug session
 */
export interface DebugSessionConfig {
  /** Command to trigger PHP execution */
  command: string;
  /** Pause at the first line of execution */
  stopOnEntry?: boolean;
  /** Pause when an exception is thrown */
  stopOnException?: boolean;
  /** Explicit path mappings (overrides auto-detection) */
  pathMappings?: PathMapping[];
  /** XDebug listener port (default: auto-detect from config) */
  port?: number;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Working directory for the trigger command */
  workingDirectory?: string;
}

// ============================================================================
// Session State
// ============================================================================

/**
 * Possible states of a debug session
 */
export type SessionStatus =
  | 'initializing'  // Session being set up
  | 'listening'     // Waiting for XDebug connection
  | 'connected'     // XDebug connected, initializing
  | 'running'       // Code executing (not paused)
  | 'paused'        // Execution paused (breakpoint/step)
  | 'stopped'       // Session ended normally
  | 'error';        // Session ended due to error

/**
 * Reason why execution paused
 */
export type PauseReason =
  | 'breakpoint_hit'  // Hit a line breakpoint
  | 'step_complete'   // Completed a step command
  | 'exception'       // Exception was thrown
  | 'entry'           // Stop on entry
  | 'user_break';     // Manual break requested

/**
 * Current state of a debug session
 */
export interface SessionState {
  /** Unique session identifier */
  id: string;
  /** Current session status */
  status: SessionStatus;
  /** Current code location (when paused) */
  location?: DebugLocation;
  /** Code snippet around current location */
  codeSnippet?: string;
  /** Why execution paused */
  pauseReason?: PauseReason;
  /** Registered breakpoints (key: "file:line") */
  breakpoints: Map<string, BreakpointConfig>;
  /** Session start time */
  startedAt: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
  /** Error message if status is 'error' */
  errorMessage?: string;
}

// ============================================================================
// Variable Inspection
// ============================================================================

/**
 * Information about a PHP variable
 */
export interface VariableInfo {
  /** Variable name (without $) */
  name: string;
  /** PHP type (string, int, array, object, etc.) */
  type: string;
  /** Variable value (for scalars) */
  value?: unknown;
  /** Child properties/elements */
  children?: VariableInfo[];
  /** Class name for objects */
  classname?: string;
  /** Full variable path (e.g., $obj->prop) */
  fullname?: string;
  /** Number of children (may be more than loaded) */
  numchildren?: number;
  /** Whether value is truncated */
  truncated?: boolean;
}

/**
 * Result of variable inspection
 */
export interface InspectResult {
  /** Variable name inspected */
  variable: string;
  /** Variable type */
  type: string;
  /** Filtered/full value */
  value?: unknown;
  /** Available property keys (for structure view) */
  keys?: string[];
  /** Error message if inspection failed */
  error?: string;
  /** Whether data was truncated due to limits */
  truncated?: boolean;
}

// ============================================================================
// Stack Frames
// ============================================================================

/**
 * A frame in the call stack
 */
export interface StackFrame {
  /** Stack level (0 = current frame) */
  level: number;
  /** Frame type */
  type: 'file' | 'eval';
  /** Source file path */
  filename: string;
  /** Line number */
  lineno: number;
  /** Function/method name */
  where?: string;
  /** Command begin position */
  cmdbegin?: string;
}

// ============================================================================
// Execution Control
// ============================================================================

/**
 * Actions for controlling debugger execution
 */
export type ExecutionAction =
  | 'step_over'   // Execute current line, skip function internals
  | 'step_into'   // Step into function call
  | 'step_out'    // Execute until current function returns
  | 'continue'    // Continue to next breakpoint
  | 'stop';       // Terminate session

// ============================================================================
// Session History (Time Travel)
// ============================================================================

/**
 * A recorded variable value at a point in time
 */
export interface SessionHistoryEntry {
  /** Database ID */
  id?: number;
  /** Session this belongs to */
  sessionId: string;
  /** Step number when recorded */
  stepNumber: number;
  /** When it was recorded */
  timestamp: Date;
  /** Location in code */
  location: DebugLocation;
  /** Variable name */
  variableName: string;
  /** Recorded value (JSON serialized) */
  variableValue: unknown;
  /** What action was taken */
  action: string;
}

/**
 * Summary of a completed debug session
 */
export interface SessionSummary {
  /** Session ID */
  sessionId: string;
  /** When session started */
  startedAt: Date;
  /** When session ended */
  endedAt: Date;
  /** Total execution steps */
  totalSteps: number;
  /** Number of breakpoints hit */
  breakpointsHit: number;
  /** Number of exceptions thrown */
  exceptionsThrown: number;
  /** Ordered list of code locations visited */
  executionPath: DebugLocation[];
  /** Variables that were inspected */
  variablesInspected: string[];
  /** Duration in milliseconds */
  duration: number;
}

// ============================================================================
// DBGp Protocol Types
// ============================================================================

/**
 * Base DBGp response
 */
export interface DbgpResponse {
  /** Command that was executed */
  command: string;
  /** Transaction ID for correlation */
  transactionId: string;
  /** Response status */
  status?: string;
  /** Status reason */
  reason?: string;
  /** Success indicator */
  success?: boolean;
}

/**
 * DBGp init response (sent when XDebug connects)
 */
export interface DbgpInitResponse extends DbgpResponse {
  /** URI of the initial file */
  fileuri: string;
  /** Programming language */
  language: string;
  /** DBGp protocol version */
  protocolVersion: string;
  /** Application/process ID */
  appid: string;
  /** IDE key for filtering */
  idekey: string;
}

/**
 * DBGp break response
 */
export interface DbgpBreakResponse extends DbgpResponse {
  /** File where break occurred */
  filename: string;
  /** Line number */
  lineno: number;
  /** Exception info if break due to exception */
  exception?: {
    name: string;
    message: string;
  };
}

/**
 * DBGp property response
 */
export interface DbgpPropertyResponse extends DbgpResponse {
  /** Retrieved property */
  property: VariableInfo;
}

// ============================================================================
// Tool Response Types
// ============================================================================

/**
 * Response from start_debug_session
 */
export interface StartSessionResponse {
  status: SessionStatus;
  session_id: string;
  message: string;
  location?: {
    file: string;
    line: number;
    function?: string;
  };
  code_snippet?: string;
  pause_reason?: PauseReason;
  hint?: string;
}

/**
 * Response from set_breakpoint
 */
export interface SetBreakpointResponse {
  success: boolean;
  breakpoint: {
    file: string;
    line: number;
    condition?: string;
    /** The resolved remote path (in container) */
    remotePath?: string;
  };
  message: string;
  hint?: string;
}

/**
 * Response from control_execution
 */
export interface ControlExecutionResponse {
  status: SessionStatus;
  action: ExecutionAction;
  message: string;
  location?: {
    file: string;
    line: number;
    function?: string;
  };
  code_snippet?: string;
  pause_reason?: PauseReason;
  hint?: string;
}

/**
 * Response from get_session_status
 */
export interface SessionStatusResponse {
  active: boolean;
  session_id?: string;
  status?: SessionStatus;
  started_at?: string;
  last_activity?: string;
  location?: {
    file: string;
    line: number;
    function?: string;
  };
  code_snippet?: string;
  pause_reason?: PauseReason;
  breakpoints?: {
    count: number;
    list: Array<{
      file: string;
      line: number;
      condition?: string;
    }>;
  };
  available_actions: string[];
  hint?: string;
  message?: string;
}
