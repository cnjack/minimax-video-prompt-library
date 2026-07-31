/** Type guard helpers for providers (kept separate to avoid import cycles). */

import { MockProvider } from '../providers/mockProvider.js';
import type { VideoProvider } from '../providers/types.js';

export function isMockProvider(provider: VideoProvider): provider is MockProvider {
  return provider instanceof MockProvider;
}
