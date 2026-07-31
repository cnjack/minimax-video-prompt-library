/**
 * Composition root for domain services. Builds the repositories from a database
 * connection and wires them to services with the selected provider.
 */

import type { ProviderName } from '@h3/shared';
import type { DB } from '../db/client.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { PromptRepository } from '../db/repositories/promptRepo.js';
import { VersionRepository } from '../db/repositories/versionRepo.js';
import type { MockProvider } from '../providers/mockProvider.js';
import { isMockProvider } from '../providers/types-util.js';
import type { VideoProvider } from '../providers/types.js';
import { GenerationService } from './generationService.js';
import { PromptService } from './promptService.js';

export interface AppServices {
  prompts: PromptService;
  generations: GenerationService;
  providerName: ProviderName;
  /** Present only when running the mock provider (scenario control). */
  mockProvider: MockProvider | null;
}

export function createAppServices(
  db: DB,
  provider: VideoProvider,
  providerMode: ProviderName,
): AppServices {
  const prompts = new PromptRepository(db);
  const versions = new VersionRepository(db);
  const jobs = new JobRepository(db);

  return {
    prompts: new PromptService(prompts, versions),
    generations: new GenerationService(versions, jobs, provider, providerMode),
    providerName: providerMode,
    mockProvider: isMockProvider(provider) ? provider : null,
  };
}
