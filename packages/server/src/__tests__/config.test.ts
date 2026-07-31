import { describe, expect, it } from 'vitest';
import {
  assertStartupConfig,
  ConfigError,
  loadConfig,
  normalizeBaseUrl,
  type AppConfig,
} from '../config.js';
import { buildHealth } from '../health.js';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    dbPath: ':memory:',
    providerMode: 'mock',
    minimaxApiKey: null,
    minimaxBaseUrl: 'https://api.minimaxi.com',
    minimaxGroupId: null,
    pollIntervalMs: 1000,
    pollMaxAttempts: 5,
    clientDist: null,
    seedSamples: false,
    instanceId: 'test',
    ...overrides,
  };
}

describe('normalizeBaseUrl', () => {
  it('strips one or more trailing slashes and trims whitespace', () => {
    expect(normalizeBaseUrl('https://api.minimaxi.com/')).toBe('https://api.minimaxi.com');
    expect(normalizeBaseUrl('https://api.minimaxi.com///')).toBe('https://api.minimaxi.com');
    expect(normalizeBaseUrl('  https://api.minimaxi.com/  ')).toBe('https://api.minimaxi.com');
    expect(normalizeBaseUrl('https://api.minimaxi.com')).toBe('https://api.minimaxi.com');
  });
});

describe('loadConfig base url', () => {
  it('normalizes a trailing slash on MINIMAX_BASE_URL', () => {
    const config = loadConfig({
      PROVIDER_MODE: 'mock',
      MINIMAX_BASE_URL: 'https://api.minimaxi.com/',
    });
    expect(config.minimaxBaseUrl).toBe('https://api.minimaxi.com');
  });
});

describe('sample seeding defaults', () => {
  it('defaults seedSamples ON in mock mode', () => {
    expect(loadConfig({ PROVIDER_MODE: 'mock' }).seedSamples).toBe(true);
  });

  it('defaults seedSamples OFF in minimax mode unless explicitly enabled', () => {
    expect(loadConfig({ PROVIDER_MODE: 'minimax', MINIMAX_API_KEY: 'k' }).seedSamples).toBe(false);
    expect(
      loadConfig({ PROVIDER_MODE: 'minimax', MINIMAX_API_KEY: 'k', SEED_SAMPLES: 'true' })
        .seedSamples,
    ).toBe(true);
    expect(
      loadConfig({ PROVIDER_MODE: 'mock', SEED_SAMPLES: 'false' }).seedSamples,
    ).toBe(false);
  });
});

describe('assertStartupConfig', () => {
  it('throws when minimax mode is selected without a key', () => {
    expect(() => assertStartupConfig(baseConfig({ providerMode: 'minimax', minimaxApiKey: null }))).toThrow(
      ConfigError,
    );
  });

  it('does not throw when minimax mode has a key', () => {
    expect(() =>
      assertStartupConfig(baseConfig({ providerMode: 'minimax', minimaxApiKey: 'k' })),
    ).not.toThrow();
  });
});

describe('buildHealth', () => {
  it('reports ok when the mock provider is configured', () => {
    const h = buildHealth(baseConfig({ providerMode: 'mock' }));
    expect(h.status).toBe('ok');
    expect(h.providerConfigured).toBe(true);
  });

  it('reports degraded when the real provider is unconfigured', () => {
    const h = buildHealth(baseConfig({ providerMode: 'minimax', minimaxApiKey: null }));
    expect(h.status).toBe('degraded');
    expect(h.providerConfigured).toBe(false);
    expect(h.mode).toBe('minimax');
  });

  it('reports ok when the real provider is configured', () => {
    const h = buildHealth(baseConfig({ providerMode: 'minimax', minimaxApiKey: 'k' }));
    expect(h.status).toBe('ok');
    expect(h.providerConfigured).toBe(true);
  });
});
