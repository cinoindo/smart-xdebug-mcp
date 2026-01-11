/**
 * Configuration management for Smart XDebug MCP
 *
 * @packageDocumentation
 * @module config
 *
 * Copyright 2026 Tyler Wall
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/**
 * Configuration schema with validation
 */
const ConfigSchema = z.object({
  /** XDebug listener port (default: 9003) */
  port: z.number().int().min(1024).max(65535).default(9003),

  /** Port range end for auto-discovery (default: 9010) */
  portRangeEnd: z.number().int().min(1024).max(65535).default(9010),

  /** Connection timeout in milliseconds (default: 30s) */
  connectionTimeout: z.number().int().min(1000).max(300_000).default(30_000),

  /** Watchdog timeout - auto-terminate idle sessions (default: 5 minutes) */
  watchdogTimeout: z.number().int().min(30_000).max(3_600_000).default(300_000),

  /** Maximum variable inspection depth (default: 3) */
  maxDepth: z.number().int().min(1).max(10).default(3),

  /** Maximum children per variable (default: 100) */
  maxChildren: z.number().int().min(1).max(1000).default(100),

  /** Default children limit for initial inspection (default: 20) */
  defaultMaxChildren: z.number().int().min(1).max(100).default(20),

  /** Enable debug logging (default: false) */
  debug: z.boolean().default(false),

  /** Data directory for session recordings */
  dataDir: z.string().optional(),

  /** Project root for path mapping */
  projectRoot: z.string().optional(),

  /** Explicit path mappings (local -> remote) */
  pathMappings: z
    .array(
      z.object({
        local: z.string(),
        remote: z.string(),
      })
    )
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Config = {
  port: 9003,
  portRangeEnd: 9010,
  connectionTimeout: 30_000,
  watchdogTimeout: 300_000, // 5 minutes
  maxDepth: 3,
  maxChildren: 100,
  defaultMaxChildren: 20,
  debug: false,
};

let currentConfig: Config = { ...DEFAULT_CONFIG };

/**
 * Load configuration from environment variables and/or explicit options
 */
export function loadConfig(overrides?: Partial<Config>): Config {
  const envConfig: Partial<Config> = {};

  // Parse environment variables
  if (process.env.XDEBUG_MCP_PORT) {
    envConfig.port = parseInt(process.env.XDEBUG_MCP_PORT, 10);
  }
  if (process.env.XDEBUG_MCP_TIMEOUT) {
    envConfig.connectionTimeout = parseInt(process.env.XDEBUG_MCP_TIMEOUT, 10);
  }
  if (process.env.XDEBUG_MCP_WATCHDOG_TIMEOUT) {
    envConfig.watchdogTimeout = parseInt(process.env.XDEBUG_MCP_WATCHDOG_TIMEOUT, 10);
  }
  if (process.env.XDEBUG_MCP_DATA_DIR) {
    envConfig.dataDir = process.env.XDEBUG_MCP_DATA_DIR;
  }
  if (process.env.DEBUG) {
    envConfig.debug = true;
  }
  if (process.env.XDEBUG_MCP_PROJECT_ROOT) {
    envConfig.projectRoot = process.env.XDEBUG_MCP_PROJECT_ROOT;
  }
  if (process.env.XDEBUG_MCP_PATH_MAPPINGS) {
    try {
      envConfig.pathMappings = JSON.parse(process.env.XDEBUG_MCP_PATH_MAPPINGS);
    } catch {
      console.error('Invalid XDEBUG_MCP_PATH_MAPPINGS JSON, ignoring');
    }
  }

  // Merge: defaults < env < explicit overrides
  const merged = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...overrides,
  };

  // Validate
  currentConfig = ConfigSchema.parse(merged);
  return currentConfig;
}

/**
 * Get the current configuration
 */
export function getConfig(): Config {
  return currentConfig;
}

/**
 * Update configuration at runtime
 */
export function updateConfig(updates: Partial<Config>): Config {
  currentConfig = ConfigSchema.parse({
    ...currentConfig,
    ...updates,
  });
  return currentConfig;
}
