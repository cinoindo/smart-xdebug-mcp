/**
 * Path Mapper
 *
 * Handles translation between local (host) and remote (container) paths.
 * Automatically ingests mappings from .vscode/launch.json or docker-compose.yml
 * per REQ-1.
 *
 * @packageDocumentation
 * @module debug/path-mapper
 *
 * Copyright 2026 Tyler Wall
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, normalize, sep } from 'path';
import type { PathMapping } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../config.js';

const logger = createLogger('path-mapper');

/** Default remote path for PHP containers */
const DEFAULT_REMOTE_PATH = '/var/www/html';

// Types for config file parsing
interface VSCodeLaunchConfig {
  version?: string;
  configurations?: Array<{
    name?: string;
    type?: string;
    pathMappings?: Record<string, string>;
  }>;
}

/**
 * Maps paths between host filesystem and remote container
 */
export class PathMapper {
  private mappings: PathMapping[] = [];
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? getConfig().projectRoot ?? process.cwd();
  }

  /**
   * Load path mappings from explicit config or auto-detect
   *
   * @param explicit - Explicit mappings to use (highest priority)
   */
  async loadMappings(explicit?: PathMapping[]): Promise<void> {
    // Explicit mappings take priority
    if (explicit && explicit.length > 0) {
      this.mappings = explicit.map((m) => ({
        local: this.normalizePath(resolve(this.projectRoot, m.local)),
        remote: this.normalizePath(m.remote),
      }));
      logger.info('Using explicit path mappings', { count: explicit.length });
      return;
    }

    // Check for mappings from config (environment variable)
    const configMappings = getConfig().pathMappings;
    if (configMappings && configMappings.length > 0) {
      this.mappings = configMappings.map((m) => ({
        local: this.normalizePath(resolve(this.projectRoot, m.local)),
        remote: this.normalizePath(m.remote),
      }));
      logger.info('Using path mappings from config', { count: this.mappings.length });
      return;
    }

    // Try .vscode/launch.json
    const vscodePath = join(this.projectRoot, '.vscode', 'launch.json');
    if (existsSync(vscodePath)) {
      const loaded = await this.loadVSCodeMappings(vscodePath);
      if (loaded) {
        logger.info('Loaded mappings from .vscode/launch.json', {
          count: this.mappings.length,
        });
        return;
      }
    }

    // Try docker-compose.yml
    const composePaths = [
      join(this.projectRoot, 'docker-compose.yml'),
      join(this.projectRoot, 'docker-compose.yaml'),
      join(this.projectRoot, 'compose.yml'),
      join(this.projectRoot, 'compose.yaml'),
    ];

    for (const composePath of composePaths) {
      if (existsSync(composePath)) {
        const loaded = await this.loadDockerComposeMappings(composePath);
        if (loaded) {
          logger.info('Loaded mappings from docker-compose', {
            count: this.mappings.length,
            file: composePath,
          });
          return;
        }
      }
    }

    // Default mapping
    this.mappings = [
      {
        local: this.normalizePath(this.projectRoot),
        remote: DEFAULT_REMOTE_PATH,
      },
    ];
    logger.info('Using default path mapping', {
      local: this.projectRoot,
      remote: DEFAULT_REMOTE_PATH,
    });
  }

  /**
   * Translate remote (container) path to local (host) path
   */
  toLocal(remotePath: string): string {
    let path = this.decodeFileUri(remotePath);
    path = this.normalizePath(path);

    // Find matching mapping (longest prefix wins)
    let bestMatch: PathMapping | undefined;
    let bestMatchLength = 0;

    for (const mapping of this.mappings) {
      if (path.startsWith(mapping.remote) && mapping.remote.length > bestMatchLength) {
        bestMatch = mapping;
        bestMatchLength = mapping.remote.length;
      }
    }

    if (bestMatch) {
      const relativePath = path.slice(bestMatch.remote.length);
      return join(bestMatch.local, relativePath);
    }

    return path;
  }

  /**
   * Translate local (host) path to remote (container) path
   */
  toRemote(localPath: string): string {
    // Handle relative paths
    const absPath = resolve(this.projectRoot, localPath);
    const normalized = this.normalizePath(absPath);

    // Find matching mapping (longest prefix wins)
    let bestMatch: PathMapping | undefined;
    let bestMatchLength = 0;

    for (const mapping of this.mappings) {
      const normalizedLocal = this.normalizePath(mapping.local);
      if (normalized.startsWith(normalizedLocal) && normalizedLocal.length > bestMatchLength) {
        bestMatch = mapping;
        bestMatchLength = normalizedLocal.length;
      }
    }

    if (bestMatch) {
      const normalizedLocal = this.normalizePath(bestMatch.local);
      const relativePath = normalized.slice(normalizedLocal.length);
      // Use forward slashes for remote paths
      return bestMatch.remote + relativePath.replace(/\\/g, '/');
    }

    return localPath;
  }

  /**
   * Get current mappings
   */
  getMappings(): PathMapping[] {
    return [...this.mappings];
  }

  /**
   * Set project root directory
   */
  setProjectRoot(root: string): void {
    this.projectRoot = root;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async loadVSCodeMappings(path: string): Promise<boolean> {
    try {
      const content = await readFile(path, 'utf-8');

      // Remove JSON comments (VSCode allows them)
      const cleaned = content
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas

      const config: VSCodeLaunchConfig = JSON.parse(cleaned);

      // Find PHP debug configuration
      const phpConfig = config.configurations?.find(
        (c) => c.type === 'php' && c.pathMappings
      );

      if (phpConfig?.pathMappings) {
        this.mappings = Object.entries(phpConfig.pathMappings).map(
          ([remote, local]) => ({
            local: this.normalizePath(resolve(this.projectRoot, local)),
            remote: this.normalizePath(remote),
          })
        );
        return this.mappings.length > 0;
      }
    } catch (err) {
      logger.warn('Failed to parse .vscode/launch.json', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  private async loadDockerComposeMappings(path: string): Promise<boolean> {
    try {
      const content = await readFile(path, 'utf-8');
      const volumes = this.extractVolumesFromYaml(content);

      const mappings: PathMapping[] = [];

      for (const volume of volumes) {
        // Parse "local:remote" or "local:remote:ro" format
        const parts = volume.split(':');
        if (parts.length >= 2) {
          const local = parts[0]!.trim();
          const remote = parts[1]!.trim();

          // Skip named volumes (no path separator and doesn't start with .)
          if (!local.includes('/') && !local.includes('\\') && !local.startsWith('.')) {
            continue;
          }

          // Skip non-code volumes
          if (remote.includes('/var/lib/') || remote.includes('/tmp/')) {
            continue;
          }

          mappings.push({
            local: this.normalizePath(resolve(this.projectRoot, local)),
            remote: this.normalizePath(remote),
          });
        }
      }

      if (mappings.length > 0) {
        this.mappings = mappings;
        return true;
      }
    } catch (err) {
      logger.warn('Failed to parse docker-compose.yml', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  /**
   * Simple YAML volume extraction without full YAML parser
   */
  private extractVolumesFromYaml(content: string): string[] {
    const volumes: string[] = [];
    const lines = content.split('\n');

    let inVolumes = false;
    let serviceIndent = -1;
    let volumesIndent = -1;

    for (const rawLine of lines) {
      const line = rawLine;
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '') continue;

      // Get indentation
      const indent = line.search(/\S/);
      if (indent === -1) continue;

      // Reset when we leave the volumes section
      if (volumesIndent >= 0 && indent <= volumesIndent && !trimmed.startsWith('-')) {
        inVolumes = false;
        volumesIndent = -1;
      }

      // Track service blocks
      if (indent === 2 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
        serviceIndent = indent;
        inVolumes = false;
        volumesIndent = -1;
        continue;
      }

      // Detect volumes: key
      if (trimmed === 'volumes:' && serviceIndent >= 0) {
        inVolumes = true;
        volumesIndent = indent;
        continue;
      }

      // Extract volume entries
      if (inVolumes && trimmed.startsWith('-')) {
        let volumeValue = trimmed.slice(1).trim();

        // Handle quoted values
        if (
          (volumeValue.startsWith('"') && volumeValue.endsWith('"')) ||
          (volumeValue.startsWith("'") && volumeValue.endsWith("'"))
        ) {
          volumeValue = volumeValue.slice(1, -1);
        }

        if (volumeValue) {
          volumes.push(volumeValue);
        }
      }
    }

    return volumes;
  }

  private decodeFileUri(uri: string): string {
    if (!uri) return '';

    if (uri.startsWith('file://')) {
      try {
        return decodeURIComponent(uri.slice(7));
      } catch {
        return uri.slice(7);
      }
    }
    return uri;
  }

  private normalizePath(path: string): string {
    // Normalize and ensure consistent separators
    let normalized = normalize(path);

    // On Windows, convert backslashes to forward slashes for consistency
    if (sep === '\\') {
      normalized = normalized.replace(/\\/g, '/');
    }

    // Remove trailing slash
    if (normalized.endsWith('/') && normalized.length > 1) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }
}
