/**
 * Provider abstraction. The MiniMax integration lives entirely behind this
 * small interface so it can be swapped (real vs. deterministic mock) by server
 * configuration and tested with a fake HTTP transport.
 */

import type {
  JobStatus,
  ProviderErrorCategory,
  ProviderName,
} from '@h3/shared';

export type MockScenario = 'success' | 'failure' | 'expired' | 'provider_error' | 'slow';

export interface CreateJobInput {
  renderedPrompt: string;
  model: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrl?: string;
  referenceVideoUrl?: string;
  referenceAudioUrl?: string;
  /** Honored only by the mock provider. */
  mockScenario?: MockScenario;
}

export interface CreateJobOutput {
  providerTaskId: string;
  status: JobStatus;
  resultUrl?: string;
}

export interface QueryJobOutput {
  providerTaskId: string;
  status: JobStatus;
  resultUrl?: string;
  /** Present when the provider reports a definitive task failure. */
  failure?: ProviderFailure;
}

export interface ProviderFailure {
  category: ProviderErrorCategory;
  message: string;
}

/**
 * Thrown when the provider rejects a create/query. Carries a stable category
 * so the service can map it to a user-facing error code.
 */
export class ProviderError extends Error {
  constructor(
    public readonly category: ProviderErrorCategory,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  toFailure(): ProviderFailure {
    return { category: this.category, message: this.message };
  }
}

export interface VideoProvider {
  readonly name: ProviderName;
  /** True when the provider has the configuration it needs to run. */
  readonly configured: boolean;
  /** Submit a new generation. Throws ProviderError on rejection. */
  create(input: CreateJobInput): Promise<CreateJobOutput>;
  /** Query an existing generation by provider task id. */
  query(providerTaskId: string): Promise<QueryJobOutput>;
}
