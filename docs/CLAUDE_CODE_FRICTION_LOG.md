# Claude Code Friction Log

This document tracks issues, confusion points, and friction encountered when Claude Code uses the smart-xdebug-mcp. These insights will inform improvements to tool descriptions, error messages, and documentation.

## Session: 2026-01-11

### Issue 1: Stale Session State
**Symptom**: Called `start_debug_session` and received error:
```json
{
  "error": "A debug session is already active. Stop it first with control_execution({action: \"stop\"}).",
  "code": "SESSION_ALREADY_ACTIVE"
}
```

**Context**: No explicit session was started in this conversation. The session may have been left over from:
- A previous Claude Code session
- A failed/interrupted previous attempt
- MCP server restart not cleaning up state

**Friction**:
- AI doesn't know if there's an active session without calling `get_session_status` first
- The `start_debug_session` tool description doesn't mention checking for existing sessions
- No automatic cleanup of stale sessions

**Suggested Improvements**:
1. Tool description should recommend calling `get_session_status` first
2. Add a `force` parameter to `start_debug_session` to auto-stop existing sessions
3. Consider auto-cleanup of sessions older than X minutes
4. Error message could include current session details (how long active, what command)

---

### Issue 2: Path Mapping Uncertainty
**Symptom**: Uncertainty about what path format to use for `set_breakpoint`

**Context**: The file exists at:
- Host: `/Projects/Octopus/components/services/laravel-app/laravel/app/Http/Controllers/Quotes/PostQuotesController.php`
- Container: `/var/www/html/app/Http/Controllers/Quotes/PostQuotesController.php`

**What I tried**: `app/Http/Controllers/Quotes/PostQuotesController.php` (relative path)

**Friction**:
- Tool description says "Local file path relative to project root" but doesn't clarify which project root (host vs container)
- No validation feedback on whether the path will actually match at runtime
- Path mapping configuration is implicit (set via env vars?) not explicit in tool calls

**Suggested Improvements**:
1. Tool response should show the resolved container path that will be used
2. Add a `validate_path` tool or parameter to check if a breakpoint path is valid
3. Document common path mapping scenarios (Docker, Laravel, etc.)
4. Consider auto-detection of common frameworks and their path structures

---

### Issue 3: Workflow Not Clear for Multi-Step Debugging
**Symptom**: Unclear what the expected workflow is

**Questions I had**:
- Should I always call `get_session_status` before starting?
- Can I add breakpoints during an active session?
- What happens to breakpoints between sessions?
- How do I debug multiple requests in sequence?

**Suggested Improvements**:
1. Add a "Quick Start" section to tool descriptions with the canonical workflow
2. Make tool descriptions reference each other (e.g., "After setting breakpoints, use start_debug_session")
3. Add state management documentation (are breakpoints persistent? per-session?)

---

### Issue 4: XDebug Trigger Method Assumptions
**Symptom**: Had to know to add `XDEBUG_SESSION=mcp` query parameter

**Context**: The Laravel app is configured with `xdebug.start_with_request=trigger` which requires a trigger.

**Friction**:
- Tool description mentions the command to trigger PHP but doesn't explain XDebug triggering
- Different environments may have different trigger methods (query param, cookie, header)
- The MCP doesn't auto-add the trigger to curl commands

**Suggested Improvements**:
1. Document common XDebug trigger methods in tool description
2. Consider auto-appending `?XDEBUG_SESSION=<idekey>` to curl URLs
3. Add configuration for default trigger method
4. Show example commands with proper triggering in tool hints

---

### Issue 5: Project Root / Path Mapping Configuration Gap
**Symptom**: Breakpoint paths won't match container paths

**Context**:
- Host file: `/Projects/Octopus/components/services/laravel-app/laravel/app/Http/Controllers/Quotes/PostQuotesController.php`
- Container file: `/var/www/html/app/Http/Controllers/Quotes/PostQuotesController.php`
- MCP uses `process.cwd()` as project root = `/Projects/Octopus`
- Default mapping: `process.cwd() → /var/www/html`
- Result: Would map to `/var/www/html/components/services/laravel-app/laravel/app/...` (WRONG)

**Friction**:
- No `XDEBUG_MCP_PROJECT_ROOT` environment variable support
- No way to configure explicit path mappings via environment
- Auto-detection only works if .vscode/launch.json or docker-compose.yml are at project root
- Claude Code has no visibility into whether path mappings are correct

**Suggested Improvements**:
1. Add `XDEBUG_MCP_PROJECT_ROOT` environment variable support
2. Add `XDEBUG_MCP_PATH_MAPPINGS` env var for explicit mappings (JSON format)
3. `set_breakpoint` response should show the resolved remote path
4. Add a `get_path_mappings` tool to inspect current configuration
5. Validate breakpoint paths exist locally before accepting

---

### Issue 6: Stuck Session in Initializing State
**Symptom**: `get_session_status` shows:
```json
{
  "active": true,
  "session_id": "pending",
  "status": "initializing",
  "started_at": "2026-01-11T01:59:50.544Z"
}
```

**Context**: A previous `start_debug_session` was called but XDebug never connected (likely because the curl command failed or the container wasn't configured correctly).

**Friction**:
- Session is stuck in limbo - active but unusable
- No timeout to auto-cleanup failed initializations
- Status "initializing" persists indefinitely
- `available_actions` is empty, unclear how to recover

**Suggested Improvements**:
1. Add initialization timeout (e.g., 30s) that auto-cleans up
2. Show the original trigger command in status for debugging
3. Include recovery hint: "Session stuck initializing. Use control_execution({action: 'stop'}) to reset."
4. Track why initialization failed (connection timeout, curl error, etc.)

---

### Issue 7: Inconsistent Session State After set_breakpoint
**Symptom**:
1. `get_session_status` returns `{"active": false}`
2. `set_breakpoint` succeeds
3. `start_debug_session` returns `SESSION_ALREADY_ACTIVE` error

**Context**: `set_breakpoint` creates a "pending" session internally for breakpoint storage, but `get_session_status` may not reflect this correctly.

**Friction**:
- Session state is confusing - is there a session or not?
- No clear way to "prepare" breakpoints without implicitly starting a session
- Forces user to stop/restart cycle unnecessarily

**Suggested Improvements**:
1. Clarify distinction between "pending" (breakpoints set, waiting to start) and "active" (connected) sessions
2. `start_debug_session` should auto-use pending session if breakpoints are set
3. Or: breakpoints should be storable without creating a session
4. `get_session_status` should clearly show "pending" state with breakpoints

---

### Issue 8: Path Mappings Not Loaded Before set_breakpoint
**Symptom**: `remotePath` in breakpoint response shows relative path, not resolved container path

**Context**: `PathMapper.loadMappings()` is only called in `startSession()`, not during `setBreakpoint()`. So when setting breakpoints before starting a session, path translation doesn't work.

**Friction**:
- Cannot verify path mapping is correct before starting session
- `remotePath` in response is misleading (shows unmapped path)
- Path mapping errors only surface when session starts

**Suggested Improvements**:
1. Load path mappings eagerly in PathMapper constructor
2. Or: call `loadMappings()` in `setBreakpoint()` if not already loaded
3. Clearly indicate if mappings haven't been loaded yet

---

### Issue 9: Multi-Service XDebug Port Conflicts
**Symptom**: API requests timeout when XDebug is enabled on backend services that MCP doesn't listen to

**Context**:
- Laravel-app uses XDebug port 7803 (MCP listening) with `start_with_request=trigger`
- Hydra-app uses XDebug port 7802 (nothing listening) with `start_with_request=default`
- Requests to v6-test endpoints proxy to v5 hydra endpoints
- Hydra's XDebug waits indefinitely for connection on 7802, causing timeout

**Friction**:
- MCP only listens on one port at a time
- No visibility into which services have XDebug enabled and on what ports
- When upstream services have XDebug issues, it affects downstream debugging

**Suggested Improvements**:
1. Support listening on multiple ports simultaneously
2. Add a tool to scan/list XDebug configurations across services
3. Provide guidance on multi-service debugging setups
4. Consider adding port range listening capability

---

## Resolution Status (Updated 2026-01-11)

### Issues Fixed by Code Changes

| Issue | Fix | Commit |
|-------|-----|--------|
| #5 Path Mapping Config | Added `XDEBUG_MCP_PROJECT_ROOT` and `XDEBUG_MCP_PATH_MAPPINGS` env vars | `1eb2ae1` |
| #7 Inconsistent State | Pending sessions now preserve breakpoints, reuse allowed | `1eb2ae1` |
| #8 Path Not Loaded | `ensureMappingsLoaded()` called in setBreakpoint | `1eb2ae1` |
| Path display "." | Handle empty filename from XDebug entry points | `34820b1` |
| Path join bug | Handle leading slash in toLocal() | `3274f70` |
| Stack frame fallback | Use stack_get for location when break event empty | `629458a` |
| DBGp params wrong | Fix property_get -d/-c usage, use feature_set | `7cbea51` |
| Variable inspection crash | Handle non-string values in parseValue | `f00d369` |

### Issues Fixed by Tool Description Improvements

| Issue | Improvement |
|-------|-------------|
| #1 Stale Session | Tool description now says to call `get_session_status` first |
| #2 Path Uncertainty | Clear PATH FORMAT examples in `set_breakpoint` description |
| #3 Workflow Unclear | WORKFLOW section added to `start_debug_session` |
| #4 XDebug Trigger | XDEBUG TRIGGERING section with examples |
| #6 Stuck Session | STUCK SESSION RECOVERY hint in `get_session_status` |

### Remaining Issues

| Issue | Status | Notes |
|-------|--------|-------|
| #9 Multi-Port | Open | Single port limitation - architectural change needed |
| JSONPath filter empty | Open | `$.REQUEST_URI` filter returns empty (may be XDebug timing) |
| `force` param | Not implemented | Could auto-stop existing sessions |
| Auto-trigger | Not implemented | Could auto-append ?XDEBUG_SESSION=1 to URLs |

---

## Improvement Categories

### Tool Descriptions (High Priority) - ✅ DONE
- [x] Add workflow guidance to each tool
- [x] Clarify path mapping expectations
- [x] Document session lifecycle
- [x] Add XDebug trigger explanation

### Error Messages (Medium Priority) - Partial
- [x] Include actionable recovery steps (in tool descriptions)
- [ ] Show relevant context (current state, elapsed time)
- [x] Suggest next tool to call

### New Features (Consider)
- [ ] `force` parameter for start_debug_session
- [x] Path validation (localFileExists in response)
- [ ] Session timeout/auto-cleanup
- [ ] Auto-trigger injection for curl commands

### Documentation (Medium Priority) - ✅ DONE
- [x] Quick start workflow guide (in tool descriptions)
- [x] TOOL_IMPROVEMENT_ANALYSIS.md created
- [ ] Troubleshooting guide for Claude Code users
