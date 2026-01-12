/**
 * MCP Tool definitions and handlers
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DebugSessionManager } from '../debug/session-manager.js';
import { handleStartDebugSession } from './start-session.js';
import { handleSetBreakpoint } from './set-breakpoint.js';
import { handleInspectVariable } from './inspect-variable.js';
import { handleControlExecution } from './control-execution.js';
import { handleGetSessionStatus } from './get-status.js';
import { handleQueryHistory } from './query-history.js';

export const tools: Tool[] = [
  {
    name: 'start_debug_session',
    description: `Starts a new PHP debugging session by listening for XDebug connections and executing a trigger command.

WORKFLOW - Call tools in this order:
1. get_session_status - Check if a session is already active
2. set_breakpoint - Set breakpoints at locations you want to inspect
3. start_debug_session - Start the session with your trigger command
4. inspect_variable / control_execution - Debug at breakpoints

BEFORE CALLING:
- Call get_session_status first. If a session is active, use control_execution with action="stop" to end it.
- Set breakpoints BEFORE calling this (unless using stop_on_entry or stop_on_exception).

XDEBUG TRIGGERING:
For xdebug.start_with_request=trigger (common in Docker), append the trigger to your URL:
- Query param: ?XDEBUG_SESSION=1
- Example: curl 'http://localhost/api/users?XDEBUG_SESSION=1'
The trigger is NOT auto-added - you must include it in your command.

HOW IT WORKS:
1. Starts listening on port 9003 (or XDEBUG_MCP_PORT)
2. Executes your trigger command in a subprocess
3. Waits for XDebug to connect (timeout: 30s)
4. Pauses when a breakpoint is hit, exception thrown, or entry reached

LIMITATIONS:
- Only one session can be active at a time
- Only listens on one port (cannot debug multiple services simultaneously)

COMMON ERRORS:
- "SESSION_ALREADY_ACTIVE": Call control_execution with action="stop" first
- Timeout: Ensure XDebug is configured and ?XDEBUG_SESSION=1 is in your URL`,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: "The command to trigger PHP execution. IMPORTANT: Include ?XDEBUG_SESSION=1 in URLs for trigger mode. Examples: 'curl http://localhost/api/users?XDEBUG_SESSION=1' or 'php artisan test --filter=UserTest'",
        },
        stop_on_entry: {
          type: 'boolean',
          description: 'If true, pauses at the very first line of execution. Use when you dont know where to set breakpoints.',
          default: false,
        },
        stop_on_exception: {
          type: 'boolean',
          description: 'If true, pauses automatically when an Error or Exception is thrown. Recommended for debugging crashes and 500 errors.',
          default: false,
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for the trigger command. Defaults to project root.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'set_breakpoint',
    description: `Sets a breakpoint at a specific file and line. Breakpoints persist until the session ends.

WHEN TO USE:
- BEFORE calling start_debug_session to set initial breakpoints
- DURING a paused session to add additional breakpoints

PATH FORMAT - Use LOCAL paths relative to your project root:
- Correct: "app/Http/Controllers/UserController.php"
- Correct: "src/Services/PaymentService.php"
- Wrong: "/var/www/html/app/..." (don't use container paths)

The tool automatically translates local paths to container paths using mappings from .vscode/launch.json, docker-compose.yml, or XDEBUG_MCP_PATH_MAPPINGS env var.

CONDITIONAL BREAKPOINTS - For loops, ALWAYS use conditions:
- '$i > 100' - Break when loop counter exceeds 100
- '$user->id === 42' - Break for specific user
- 'count($items) > 0' - Break when array has items

RETURNS:
- breakpoint_id: Unique identifier
- remotePath: The translated container path (verify this matches your container)
- warning: Included if local file doesn't exist

AFTER SETTING: Call start_debug_session to begin debugging.`,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'LOCAL file path relative to project root. Example: "app/Http/Controllers/UserController.php". Do NOT use container paths like /var/www/html/...',
        },
        line: {
          type: 'integer',
          description: 'Line number to break at. Use the line with the code you want to inspect.',
        },
        condition: {
          type: 'string',
          description: "PHP expression - break only if true. HIGHLY RECOMMENDED for loops. Examples: '$user->id === 5', '$i > 100', 'count($items) > 0'",
        },
      },
      required: ['file', 'line'],
    },
  },
  {
    name: 'inspect_variable',
    description: `Inspects a PHP variable's value at the current breakpoint. Only works when session is PAUSED.

WHEN TO USE:
- After hitting a breakpoint (status="paused")
- To examine specific values causing bugs
- To understand object structure before filtering

CONTEXT EFFICIENCY - Full dumps are expensive. Use JSONPath filters:
BAD (returns thousands of lines):
  inspect_variable("$order")
GOOD (returns only what you need):
  inspect_variable("$order", "$.total")
  inspect_variable("$order", "$.items[*].sku")
  inspect_variable("$request", "$.input.email")

Without a filter, returns structure only (keys/types, no values).

JSONPATH EXAMPLES:
- '$.property' - Single property
- '$.items[0]' - First array element
- '$.items[*].id' - All IDs in items array
- '$.user.profile.name' - Nested property

REQUIRES: Session must be paused. Call get_session_status to verify.

COMMON VARIABLES:
- '$this' - Current object instance
- '$request' - HTTP request (Laravel)
- '$_GET', '$_POST', '$_SERVER' - PHP superglobals`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "PHP variable name including $. Examples: '$this', '$request', '$user', '$_SERVER'",
        },
        filter: {
          type: 'string',
          description: "JSONPath to filter results. Examples: '$.email', '$.items[0].price', '$.user.name'. Omit for structure-only view.",
        },
        depth: {
          type: 'integer',
          description: 'Recursion depth for nested objects. Default 1, max 3. Higher values return more data but cost more context.',
          default: 1,
          minimum: 1,
          maximum: 3,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'control_execution',
    description: `Controls the debugger's execution flow. Use to step through code or end sessions.

ACTIONS:

step_over: Execute current line, pause at next line in same scope.
  Use when: Line calls a function you don't need to debug.
  Example: Skip framework internals, focus on your logic.

step_into: Step INTO the function call on the current line.
  Use when: You need to debug inside a called function.
  Example: Debug why UserService::create() fails.

step_out: Run until current function returns to its caller.
  Use when: Done debugging a function, want to return to caller.
  Example: Finished debugging a helper, return to controller.

continue: Run until next breakpoint or exception.
  Use when: Skip to the next interesting point.
  Example: Jump from authentication to order processing.

stop: Terminate the debug session immediately.
  Use when: Done debugging, or session is stuck/errored.
  IMPORTANT: Always stop sessions when done to free the port.

REQUIRES:
- Any action: Session must be active
- step_over/step_into/step_out/continue: Session must be paused

AFTER STOP: You can start a new session with start_debug_session.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['step_over', 'step_into', 'step_out', 'continue', 'stop'],
          description: "The action: 'step_over' (next line), 'step_into' (enter function), 'step_out' (exit function), 'continue' (run to breakpoint), 'stop' (end session)",
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_session_status',
    description: `Returns the current debug session status. Call this FIRST before starting a new session.

WHEN TO USE:
- Before start_debug_session: Check if a session is already active
- During debugging: See current location and available actions
- After errors: Diagnose session state

RETURNS:
- active: Whether a session exists
- status: Current state (see below)
- location: Current file and line when paused
- available_actions: Valid control_execution actions
- breakpoints: List of registered breakpoints

SESSION STATES:
- "initializing": Starting, waiting for XDebug connection
- "listening": Listening for connections (XDebug not connected yet)
- "connected": XDebug connected, execution starting
- "paused": Stopped at breakpoint - can inspect variables and step
- "running": Code executing, waiting for breakpoint
- "stopped": Session ended
- "error": Session in error state

STUCK SESSION RECOVERY:
If status is "initializing" for >30 seconds, the connection likely failed. Use control_execution with action="stop" to reset, then check your XDebug configuration.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'query_history',
    description: `Query past variable values from the session recorder (time-travel debugging).

WHEN TO USE:
- To see how a variable changed over execution steps
- To compare values between steps without re-running
- To understand state progression leading to a bug

DOES NOT REQUIRE PAUSED STATE - can query history anytime during an active session.

RETURNS:
Array of historical values with step numbers and timestamps, showing how the variable changed over time.

LIMITATION: Only variables that were inspected via inspect_variable are recorded. If you didn't inspect a variable at a step, it won't have history for that step.

EXAMPLE USAGE:
"What was $user->status 3 steps ago?"
  query_history("$user->status", steps_ago=3)

"Show me the last 10 values of $total"
  query_history("$total", limit=10)`,
    inputSchema: {
      type: 'object',
      properties: {
        variable_name: {
          type: 'string',
          description: "PHP variable name to query history for. Example: '$user', '$status', '$order->total'",
        },
        steps_ago: {
          type: 'integer',
          description: 'How many steps back to look. 0 = current step, 1 = previous step, 2 = two steps ago, etc.',
          default: 1,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of history entries to return. Useful for seeing variable progression over time.',
          default: 5,
        },
      },
      required: ['variable_name'],
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  sessionManager: DebugSessionManager
): Promise<unknown> {
  switch (name) {
    case 'start_debug_session':
      return handleStartDebugSession(args, sessionManager);
    case 'set_breakpoint':
      return handleSetBreakpoint(args, sessionManager);
    case 'inspect_variable':
      return handleInspectVariable(args, sessionManager);
    case 'control_execution':
      return handleControlExecution(args, sessionManager);
    case 'get_session_status':
      return handleGetSessionStatus(sessionManager);
    case 'query_history':
      return handleQueryHistory(args, sessionManager);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
