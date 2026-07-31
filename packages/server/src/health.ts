/**
 * Health check. Application health is independent of provider configuration:
 * a missing paid key never masquerades as an outage (it is reported separately
 * via `providerConfigured` and the `degraded` flag).
 *
 * Route behavior is deliberate for Kubernetes:
 *  - `/api/healthz` (liveness) always returns 200 `ok` — the process is alive.
 *  - `/api/health` (readiness) always returns 200 so the app receives traffic
 *    even before a paid key is configured; `status` is `degraded` (not an HTTP
 *    error) to flag that generation would fail without the key.
 */

import type { AppConfig } from './config.js';
import type { HealthStatus } from '@h3/shared';

export function buildHealth(config: AppConfig): HealthStatus {
  const providerConfigured =
    config.providerMode === 'mock'
      ? true
      : Boolean(config.minimaxApiKey);

  return {
    status: providerConfigured ? 'ok' : 'degraded',
    mode: config.providerMode,
    providerConfigured,
    timestamp: new Date().toISOString(),
  };
}
