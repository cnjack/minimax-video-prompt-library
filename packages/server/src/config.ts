/**
 * Server configuration. All values are read from the environment so the same
 * image runs in mock mode locally and real mode in production. MiniMax
 * credentials are read here, server-side, and never forwarded to the client.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type ProviderMode = 'mock' | 'minimax';

export interface AppConfig {
  port: number;
  nodeEnv: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  providerMode: ProviderMode;
  minimaxApiKey: string | null;
  minimaxBaseUrl: string;
  minimaxGroupId: string | null;
  /** Interval between poll sweeps, ms. */
  pollIntervalMs: number;
  /** Max consecutive provider failures before a job is marked failed. */
  pollMaxAttempts: number;
  /** Optional directory of the built client to serve (production single-image). */
  clientDist: string | null;
  /** Whether to seed sample prompts when the DB is empty. */
  seedSamples: boolean;
  /** Per-process instance id, included in logs. */
  instanceId: string;
}

function readMode(env: NodeJS.ProcessEnv): ProviderMode {
  const raw = (env.PROVIDER_MODE ?? env.H3_PROVIDER_MODE ?? 'mock')
    .trim()
    .toLowerCase();
  if (raw !== 'mock' && raw !== 'minimax') {
    throw new ConfigError(
      `PROVIDER_MODE must be "mock" or "minimax" (got "${raw}").`,
    );
  }
  return raw;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerMode = readMode(env);
  const minimaxApiKey =
    (env.MINIMAX_API_KEY && env.MINIMAX_API_KEY.trim().length > 0
      ? env.MINIMAX_API_KEY.trim()
      : null) ?? null;

  const dbPath = path.resolve(env.DB_PATH ?? './data/h3-studio.db');
  const hasSeedSamplesFlag =
    env.SEED_SAMPLES !== undefined && env.SEED_SAMPLES.trim().length > 0;

  const config: AppConfig = {
    port: intOr(env.PORT, 3001),
    nodeEnv: env.NODE_ENV ?? 'development',
    dbPath,
    providerMode,
    minimaxApiKey,
    minimaxBaseUrl: normalizeBaseUrl(env.MINIMAX_BASE_URL ?? 'https://api.minimax.io'),
    minimaxGroupId:
      (env.MINIMAX_GROUP_ID && env.MINIMAX_GROUP_ID.trim()) || null,
    pollIntervalMs: intOr(env.POLL_INTERVAL_MS, 2000),
    pollMaxAttempts: intOr(env.POLL_MAX_ATTEMPTS, 120),
    clientDist: env.CLIENT_DIST ? path.resolve(env.CLIENT_DIST) : null,
    // Sample prompts are for first-time mock users. In real (minimax) mode they
    // default OFF unless explicitly enabled so production does not silently gain
    // seeded demo data.
    seedSamples: hasSeedSamplesFlag
      ? boolOr(env.SEED_SAMPLES, true)
      : providerMode === 'mock',
    instanceId: randomUUID(),
  };

  return config;
}

/**
 * Fail visibly at startup when real mode is selected without a key. The server
 * must never silently fall back from real mode to mock mode.
 */
export function assertStartupConfig(config: AppConfig): void {
  if (config.providerMode === 'minimax' && !config.minimaxApiKey) {
    throw new ConfigError(
      'PROVIDER_MODE=minimax requires MINIMAX_API_KEY to be set. Refusing to ' +
        'start: real mode will never silently fall back to mock mode.',
    );
  }
}

function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`Expected an integer, got "${value}".`);
  }
  return parsed;
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Normalize the MiniMax base URL: trim whitespace and strip trailing slashes so
 * the transport can safely concatenate `/v1/...` without producing `//v1/...`.
 */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
