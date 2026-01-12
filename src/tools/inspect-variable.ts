/**
 * inspect_variable Tool Handler
 *
 * Implements "Surgical" variable inspection with JSONPath filtering
 * per REQ-5 and REQ-6.
 */

import { z } from 'zod';
import { JSONPath } from 'jsonpath-plus';
import type { DebugSessionManager } from '../debug/session-manager.js';
import type { VariableInfo } from '../types/index.js';

const InspectVariableSchema = z.object({
  name: z.string().min(1, 'Variable name is required'),
  filter: z.string().optional(),
  depth: z.number().int().min(1).max(3).optional().default(1),
});

const DEFAULT_MAX_CHILDREN = 20; // REQ-6

export async function handleInspectVariable(
  args: Record<string, unknown>,
  sessionManager: DebugSessionManager
): Promise<unknown> {
  const parsed = InspectVariableSchema.parse(args);

  const variable = await sessionManager.inspectVariable(
    parsed.name,
    parsed.depth,
    DEFAULT_MAX_CHILDREN
  );

  if (!variable) {
    return {
      error: `Variable '${parsed.name}' not found in current scope`,
      hint: "Check the variable name. Use '$this' for object context, '$_REQUEST' for request data.",
    };
  }

  // Convert to JSON-friendly format
  const jsonValue = variableToJson(variable);

  // Apply JSONPath filter if provided
  if (parsed.filter) {
    try {
      const filtered = JSONPath({
        path: parsed.filter,
        json: jsonValue as object,
        wrap: false,
      });

      return {
        variable: parsed.name,
        filter: parsed.filter,
        type: variable.type,
        value: filtered,
        truncated: false,
      };
    } catch {
      // Invalid JSONPath - return structure with available keys
      const keys = extractKeys(jsonValue);
      return {
        error: `Invalid JSONPath filter: ${parsed.filter}`,
        variable: parsed.name,
        type: variable.type,
        available_keys: keys,
        hint: `Try one of: ${keys.slice(0, 5).map(k => `'$.${k}'`).join(', ')}`,
      };
    }
  }

  // No filter - return structure summary only (REQ-6: prevent context pollution)
  const structure = summarizeStructure(variable);

  return {
    variable: parsed.name,
    type: variable.type,
    classname: variable.classname,
    structure,
    hint: structure.children_count && structure.children_count > 0
      ? `This ${variable.type} has ${structure.children_count} children. Use 'filter' to inspect specific properties (e.g., filter: '$.propertyName')`
      : undefined,
  };
}

function variableToJson(variable: VariableInfo): unknown {
  if (variable.children && variable.children.length > 0) {
    // Array or object
    if (variable.type === 'array') {
      return variable.children.map((child) => variableToJson(child));
    } else {
      const obj: Record<string, unknown> = {};
      for (const child of variable.children) {
        obj[child.name] = variableToJson(child);
      }
      return obj;
    }
  }

  return variable.value;
}

function summarizeStructure(variable: VariableInfo): {
  type: string;
  classname?: string;
  keys?: string[];
  children_count?: number;
  preview?: unknown;
} {
  const summary: {
    type: string;
    classname?: string;
    keys?: string[];
    children_count?: number;
    preview?: unknown;
  } = {
    type: variable.type,
  };

  if (variable.classname) {
    summary.classname = variable.classname;
  }

  if (variable.children && variable.children.length > 0) {
    summary.keys = variable.children.map((c) => c.name);
    summary.children_count = variable.numchildren ?? variable.children.length;

    // Provide a small preview for simple values
    const previewChildren = variable.children.slice(0, 3);
    const preview: Record<string, string> = {};
    for (const child of previewChildren) {
      if (!child.children || child.children.length === 0) {
        preview[child.name] = `(${child.type}) ${String(child.value ?? '').slice(0, 50)}`;
      } else {
        preview[child.name] = `(${child.type}) [${child.numchildren ?? child.children.length} children]`;
      }
    }
    summary.preview = preview;
  } else if (variable.value !== undefined) {
    // Scalar value - show it directly
    summary.preview = variable.value;
  }

  return summary;
}

function extractKeys(value: unknown, prefix: string = ''): string[] {
  const keys: string[] = [];

  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      keys.push(prefix ? `${prefix}[*]` : '[*]');
      if (value.length > 0 && typeof value[0] === 'object') {
        keys.push(...extractKeys(value[0], prefix ? `${prefix}[0]` : '[0]'));
      }
    } else {
      for (const key of Object.keys(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        keys.push(path);
        const childValue = (value as Record<string, unknown>)[key];
        if (childValue && typeof childValue === 'object') {
          keys.push(...extractKeys(childValue, path));
        }
      }
    }
  }

  return keys.slice(0, 20); // Limit to prevent huge lists
}
