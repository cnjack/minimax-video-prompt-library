/**
 * Health check. Application health is independent of provider configuration:
 * a missing paid key never masquerades as an outage (it is reported separately).
 */

import type { AppConfig } from './config.js';
import type { HealthStatus } from '@h3/shared';

export function buildHealth(config: AppConfig): HealthStatus {
  const providerConfigured =
    config.providerMode === 'mock'
      ? true
      : Boolean(config.minimaxApiKey);

  return {
    status: 'ok',
    mode: config.providerMode,
    providerConfigured,
    timestamp: new Date().toISOString(),
  };
}
