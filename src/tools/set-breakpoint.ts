/**
 * set_breakpoint Tool Handler
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import type { DebugSessionManager } from '../debug/session-manager.js';
import { getConfig } from '../config.js';

const SetBreakpointSchema = z.object({
  file: z.string().min(1, 'File path is required'),
  line: z.number().int().positive('Line must be a positive integer'),
  condition: z.string().optional(),
});

export async function handleSetBreakpoint(
  args: Record<string, unknown>,
  sessionManager: DebugSessionManager
): Promise<unknown> {
  const parsed = SetBreakpointSchema.parse(args);

  // Check if local file exists (helpful warning for path issues)
  const projectRoot = getConfig().projectRoot ?? process.cwd();
  const absolutePath = resolve(projectRoot, parsed.file);
  const localFileExists = existsSync(absolutePath);

  const breakpoint = await sessionManager.setBreakpoint({
    file: parsed.file,
    line: parsed.line,
    condition: parsed.condition,
  });

  const remotePathInfo = breakpoint.remotePath
    ? ` (container: ${breakpoint.remotePath})`
    : '';

  // Build warning if local file doesn't exist
  const pathWarning = !localFileExists
    ? `\n\nWARNING: Local file not found at '${absolutePath}'. This may indicate incorrect path mappings. Verify:\n` +
      `  - Project root: ${projectRoot}\n` +
      `  - Expected local path: ${absolutePath}\n` +
      `  - Remote path will be: ${breakpoint.remotePath ?? '(not resolved)'}`
    : '';

  return {
    success: true,
    breakpoint: {
      file: breakpoint.file,
      line: breakpoint.line,
      condition: breakpoint.condition,
      remotePath: breakpoint.remotePath,
      localFileExists,
    },
    message: breakpoint.condition
      ? `Conditional breakpoint set at ${breakpoint.file}:${breakpoint.line}${remotePathInfo} (when: ${breakpoint.condition})${pathWarning}`
      : `Breakpoint set at ${breakpoint.file}:${breakpoint.line}${remotePathInfo}${pathWarning}`,
    hint: "Call 'start_debug_session' to begin debugging. The breakpoint will trigger when execution reaches this line.",
  };
}
