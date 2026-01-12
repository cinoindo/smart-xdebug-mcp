# Tool Description Improvement Analysis

This document analyzes the friction log against Anthropic's tool use best practices and proposes specific improvements.

## Summary of Findings

### Gap Analysis: Current vs Best Practices

| Anthropic Guideline | Current State | Gap |
|---------------------|---------------|-----|
| 3-4+ sentences per tool | 2-3 sentences | **Needs expansion** |
| When to use AND when NOT to | Partial (only when to use) | **Missing "don't use when"** |
| Workflow guidance | Missing | **Critical gap** |
| Error recovery hints | Missing | **Critical gap** |
| Parameter behavior details | Partial | Needs expansion |
| Input examples | None | Consider adding |

### Friction Log → Tool Description Mapping

| Issue | Root Cause | Tool(s) Affected | Fix Type |
|-------|------------|------------------|----------|
| #1 Stale Session | No workflow guidance | start_debug_session | Description |
| #2 Path Uncertainty | Unclear path format | set_breakpoint | Description + Response |
| #3 Workflow Unclear | No sequencing guidance | ALL tools | Description |
| #4 XDebug Trigger | Missing trigger docs | start_debug_session | Description |
| #5 Path Mapping Config | No config visibility | set_breakpoint | Description + New tool |
| #6 Stuck Session | No recovery hints | get_session_status | Description + Response |
| #7 Inconsistent State | Pending vs active confusion | set_breakpoint, start | Description |
| #8 Path Not Loaded | Implementation timing | set_breakpoint | Code fix (done) |
| #9 Multi-Port | Single port limitation | start_debug_session | Description (limitation) |

---

## Detailed Recommendations by Tool

### 1. `start_debug_session`

**Current Description (119 words):**
```
Starts a new PHP debugging session. You MUST set breakpoints via 'set_breakpoint'
BEFORE calling this unless using stop_on_entry or stop_on_exception.

The system will:
1. Start listening for XDebug connections
2. Execute your trigger command (curl, php artisan, etc.)
3. Pause when a breakpoint is hit or exception thrown

Returns session status and location when paused.
```

**Issues Addressed:** #1, #3, #4, #6, #7, #9

**Recommended Description (~300 words):**
```
Starts a new PHP debugging session by listening for XDebug connections and
executing a trigger command.

WORKFLOW - Call tools in this order:
1. get_session_status - Check if a session is already active
2. set_breakpoint - Set breakpoints at locations you want to inspect
3. start_debug_session - Start the session with your trigger command
4. inspect_variable / control_execution - Debug at breakpoints

BEFORE CALLING:
- Call get_session_status first. If a session is active, use control_execution
  with action="stop" to end it before starting a new one.
- Set breakpoints BEFORE calling this tool (unless using stop_on_entry or
  stop_on_exception).

XDEBUG TRIGGERING:
For xdebug.start_with_request=trigger (common in Docker), append the trigger
to your URL:
- Query param: ?XDEBUG_SESSION=1
- Example: curl 'http://localhost/api/users?XDEBUG_SESSION=1'

The trigger is NOT auto-added - you must include it in your command.

HOW IT WORKS:
1. Starts listening on port 9003 (or XDEBUG_MCP_PORT)
2. Executes your trigger command in a subprocess
3. Waits for XDebug to connect (timeout: 30s)
4. Pauses when a breakpoint is hit, exception thrown, or entry reached

RETURNS: Session status including current file, line, and available actions.

LIMITATIONS:
- Only one session can be active at a time
- Only listens on one port (cannot debug multiple services simultaneously)
- Trigger command runs in a subprocess; complex shell commands may need
  a wrapper script

COMMON ERRORS:
- "SESSION_ALREADY_ACTIVE": Call get_session_status, then control_execution
  with action="stop" to end the existing session.
- Timeout: Ensure XDebug is configured and the trigger parameter is included
  in your URL.
```

---

### 2. `set_breakpoint`

**Current Description (54 words):**
```
Sets a breakpoint at a specific file and line. Use BEFORE starting a debug session.

Path translation is automatic - use local paths relative to project root.
Conditional breakpoints are HIGHLY RECOMMENDED for loops to avoid stepping
through thousands of iterations.
```

**Issues Addressed:** #2, #5, #7, #8

**Recommended Description (~200 words):**
```
Sets a breakpoint at a specific file and line. Breakpoints persist until the
session ends or is stopped.

WHEN TO USE:
- BEFORE calling start_debug_session to set initial breakpoints
- DURING a paused session to add additional breakpoints

PATH FORMAT:
Use LOCAL paths relative to your project root (where .mcp.json is located).
- Correct: "app/Http/Controllers/UserController.php"
- Correct: "src/Services/PaymentService.php"
- Wrong: "/var/www/html/app/..." (container path)

The tool automatically translates local paths to container paths using mappings
from .vscode/launch.json, docker-compose.yml, or XDEBUG_MCP_PATH_MAPPINGS env var.

CONDITIONAL BREAKPOINTS:
For loops, ALWAYS use conditions to avoid thousands of iterations:
- '$i > 100' - Break when loop counter exceeds 100
- '$user->id === 42' - Break for specific user
- 'count($items) > 0' - Break when array has items

RETURNS:
- breakpoint_id: Unique identifier for this breakpoint
- remotePath: The translated container path (verify this matches your container)
- warning: If the local file doesn't exist, a warning is included

AFTER SETTING:
Call start_debug_session to begin debugging with your breakpoints.
```

---

### 3. `get_session_status`

**Current Description (12 words):**
```
Returns current debug session status, location, and available actions.
```

**Issues Addressed:** #1, #3, #6

**Recommended Description (~150 words):**
```
Returns the current debug session status. Call this FIRST before other tools
to understand the current state.

WHEN TO USE:
- Before start_debug_session: Check if a session is already active
- During debugging: See current location and available actions
- After errors: Diagnose session state

RETURNS:
- active: Whether a session exists
- status: Current state (initializing, listening, connected, running, paused,
  stopped, error)
- location: Current file and line when paused
- available_actions: What control_execution actions are valid
- breakpoints: List of registered breakpoints

SESSION STATES:
- "initializing": Session starting, waiting for XDebug connection
- "listening": Listening for connections (no XDebug connected yet)
- "connected": XDebug connected, execution starting
- "paused": Stopped at breakpoint - can inspect variables
- "running": Code executing, waiting for breakpoint
- "stopped": Session ended
- "error": Session in error state

STUCK SESSION RECOVERY:
If status is "initializing" for >30 seconds, the connection likely failed.
Use control_execution with action="stop" to reset.
```

---

### 4. `inspect_variable`

**Current Description (73 words):**
```
Surgically inspects a variable's value. Returns JSON.

CONTEXT COST WARNING: Reading full objects is expensive. ALWAYS use filters.
- BAD:  inspect_variable("$order") → Returns 5000 lines
- GOOD: inspect_variable("$order", "$.items[*].sku") → Returns 5 lines

Without a filter, returns only structure summary (keys/types, no values).
```

**Issues Addressed:** None specific, but needs workflow context

**Recommended Description (~180 words):**
```
Inspects a PHP variable's value at the current breakpoint. Only works when
session is PAUSED.

WHEN TO USE:
- After hitting a breakpoint (status="paused")
- To examine specific values causing bugs
- To understand object structure before filtering

CONTEXT EFFICIENCY:
Full object dumps are expensive and may exceed context limits. Use JSONPath
filters to extract only what you need:

BAD (returns thousands of lines):
  inspect_variable("$order")

GOOD (returns only what you need):
  inspect_variable("$order", "$.total")
  inspect_variable("$order", "$.items[*].sku")
  inspect_variable("$request", "$.input.email")

Without a filter, returns structure only (keys and types, no values) to help
you write targeted filters.

JSONPATH EXAMPLES:
- '$.property' - Single property
- '$.items[0]' - First array element
- '$.items[*].id' - All IDs in array
- '$.user.profile.name' - Nested property

REQUIRES:
Session must be paused (status="paused"). Call get_session_status to verify.

COMMON VARIABLES:
- '$this' - Current object instance
- '$request' - HTTP request (Laravel)
- '$_GET', '$_POST' - PHP superglobals
```

---

### 5. `control_execution`

**Current Description (54 words):**
```
Controls debugger execution flow.

Actions:
- step_over: Execute current line, pause at next line (skip function internals)
- step_into: Step into function call on current line
- step_out: Run until current function returns
- continue: Run until next breakpoint or exception
- stop: Terminate debug session
```

**Issues Addressed:** #1, #6

**Recommended Description (~200 words):**
```
Controls the debugger's execution flow. Use to step through code or end sessions.

ACTIONS:

step_over: Execute current line, pause at next line in same scope.
  Use when: Current line calls a function you don't need to debug.
  Example: Skip framework code, focus on your logic.

step_into: Step INTO the function call on the current line.
  Use when: You need to debug what happens inside a called function.
  Example: Debug why UserService::create() fails.

step_out: Run until current function returns to its caller.
  Use when: You're deep in a function and want to return to the caller.
  Example: Done debugging a helper, return to main logic.

continue: Run until the next breakpoint or exception.
  Use when: You want to skip to the next interesting point.
  Example: Jump from login to order creation.

stop: Terminate the debug session immediately.
  Use when: Done debugging, or session is stuck/errored.
  IMPORTANT: Always stop sessions when done to free the port.

REQUIRES:
Session must be active. For step_over/step_into/step_out/continue,
session must be paused.

AFTER STOP:
You can start a new session with start_debug_session.
```

---

### 6. `query_history`

**Current Description (47 words):**
```
Query the session recorder to see past variable values (time-travel debugging).

Use this to check what a variable was N steps ago without stepping the debugger back.
Example: "What was $status 3 steps ago?"
```

**Issues Addressed:** None specific, needs workflow context

**Recommended Description (~120 words):**
```
Query past variable values from the session recorder (time-travel debugging).
Variables are automatically recorded at each step.

WHEN TO USE:
- To see how a variable changed over execution
- To compare values between steps without re-running
- To understand state progression leading to a bug

DOES NOT REQUIRE PAUSED STATE - can query history anytime during an active
session.

PARAMETERS:
- variable_name: The PHP variable (e.g., '$user', '$status')
- steps_ago: How many steps back (0=current, 1=previous, etc.)
- limit: Max history entries to return

RETURNS:
Array of historical values with step numbers and timestamps.

NOTE: Only variables that were inspected are recorded. If you didn't call
inspect_variable on a variable, it won't have history.
```

---

## New Tool Recommendation

### `get_path_mappings` (NEW)

Based on Issue #5, add a tool to inspect path mapping configuration:

```javascript
{
  name: 'get_path_mappings',
  description: `Shows the current path mapping configuration used to translate
local paths to container paths.

WHEN TO USE:
- To verify breakpoint paths will map correctly
- To debug "breakpoint not hit" issues
- To understand how local → container translation works

RETURNS:
- mappings: Array of {local, remote} path pairs
- source: Where mappings came from (env, vscode, docker-compose, default)
- projectRoot: The local project root being used

If mappings look wrong, set XDEBUG_MCP_PATH_MAPPINGS environment variable:
  XDEBUG_MCP_PATH_MAPPINGS='[{"local":"/my/project","remote":"/var/www/html"}]'`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
}
```

---

## Error Message Improvements

Based on Issue #6, improve error messages with recovery hints:

### SESSION_ALREADY_ACTIVE
**Current:**
```json
{
  "error": "A debug session is already active. Stop it first with control_execution({action: \"stop\"}).",
  "code": "SESSION_ALREADY_ACTIVE"
}
```

**Improved:**
```json
{
  "error": "A debug session is already active.",
  "code": "SESSION_ALREADY_ACTIVE",
  "recovery": "Call control_execution with action='stop' to end the current session, then retry.",
  "current_session": {
    "id": "abc-123",
    "status": "paused",
    "started_at": "2026-01-11T01:59:50.544Z",
    "duration_seconds": 45
  }
}
```

### CONNECTION_TIMEOUT
**Current:**
```json
{
  "error": "Connection timeout",
  "code": "CONNECTION_TIMEOUT"
}
```

**Improved:**
```json
{
  "error": "XDebug did not connect within 30 seconds.",
  "code": "CONNECTION_TIMEOUT",
  "recovery": "Check that: (1) XDebug is enabled in your PHP container, (2) xdebug.client_host points to your host, (3) Your trigger command includes ?XDEBUG_SESSION=1 for trigger mode.",
  "trigger_command": "curl http://localhost/api/users",
  "expected_trigger": "curl 'http://localhost/api/users?XDEBUG_SESSION=1'"
}
```

---

## Implementation Priority

### High Priority (Friction Impact)
1. Expand `start_debug_session` description with workflow guidance
2. Expand `get_session_status` with state descriptions and recovery hints
3. Expand `set_breakpoint` with path format clarity
4. Improve error messages with recovery hints

### Medium Priority (Usability)
5. Expand `control_execution` with use-case examples
6. Expand `inspect_variable` with JSONPath examples
7. Add `get_path_mappings` tool

### Low Priority (Polish)
8. Expand `query_history` with limitations
9. Add `input_examples` to complex tools
10. Add tool annotations (readOnlyHint, destructiveHint)

---

## Sources

- [Anthropic Tool Use Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- Internal Friction Log: `docs/CLAUDE_CODE_FRICTION_LOG.md`
