/**
 * Provider factory. Selects the real MiniMax adapter or the deterministic mock
 * based on configuration. Real mode is only constructed when a key is present;
 * the app asserts that invariant at startup.
 */

import type { AppConfig } from '../config.js';
import { MinimaxProvider } from './minimaxProvider.js';
import { MockProvider } from './mockProvider.js';
import type { VideoProvider } from './types.js';

export function createProvider(config: AppConfig): VideoProvider {
  if (config.providerMode === 'minimax') {
    if (!config.minimaxApiKey) {
      // Defensive: startup asserts this, but guard generation time too.
      throw new Error(
        'Cannot create real MiniMax provider without MINIMAX_API_KEY.',
      );
    }
    return new MinimaxProvider({
      baseUrl: config.minimaxBaseUrl,
      apiKey: config.minimaxApiKey,
      groupId: config.minimaxGroupId,
      log: (level, message) => console[level](`[minimax] ${message}`),
    });
  }
  return new MockProvider();
}

export { MinimaxProvider, MockProvider };
export type { VideoProvider, MockScenario } from './types.js';
