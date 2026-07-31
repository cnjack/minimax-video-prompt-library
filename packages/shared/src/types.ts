/**
 * Domain model and API response contract types shared by the client and server.
 *
 * The client imports these types (and the zod schemas) but never the server
 * implementation. Request validation lives in `./schemas.ts`.
 */

import type { ProviderErrorCategory } from './errors.js';

/** Lifecycle status for a prompt in the library. */
export type PromptStatus = 'draft' | 'active' | 'archived';

/** A reusable, versioned prompt identity. */
export interface Prompt {
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: PromptStatus;
  /** The current head version id (immutable pointer). */
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** An immutable snapshot of a prompt template. */
export interface PromptVersion {
  id: string;
  promptId: string;
  /** 1-based, increasing within a prompt. */
  versionNumber: number;
  /** The raw template body containing `{{variable}}` placeholders. */
  content: string;
  /** Variables detected from the content, snapshotted for reproducibility. */
  variables: string[];
  createdAt: string;
}

/** Local job state machine. */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'expired';

/** Which adapter produced this job. */
export type ProviderName = 'mock' | 'minimax';

/** Full generation job record, as returned by the API. */
export interface GenerationJob {
  id: string;
  promptId: string;
  promptVersionId: string;
  /** Fully rendered prompt actually sent to the provider. */
  renderedPrompt: string;
  model: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  firstFrameUrl: string | null;
  lastFrameUrl: string | null;
  referenceImageUrl: string | null;
  referenceVideoUrl: string | null;
  referenceAudioUrl: string | null;
  status: JobStatus;
  provider: ProviderName;
  providerTaskId: string | null;
  /** Output media URL on success. */
  resultUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Client-supplied (or generated) idempotency key. */
  idempotencyKey: string;
  /** Stable hash of the request payload (for idempotency conflict checks). */
  idempotencyPayloadHash: string;
  parameters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Reduced view of a job for list responses. */
export type GenerationJobSummary = Pick<
  GenerationJob,
  | 'id'
  | 'promptId'
  | 'promptVersionId'
  | 'status'
  | 'provider'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
  | 'resultUrl'
  | 'errorMessage'
>;

/** Outcome of an idempotent submission. */
export interface CreateGenerationResponse {
  job: GenerationJob;
  /** True when an existing job was reused for the same idempotency key. */
  reused: boolean;
}

export interface PromptDetail {
  prompt: Prompt;
  versions: PromptVersion[];
}

/** Distinct application vs. provider-configuration health. */
export interface HealthStatus {
  status: 'ok' | 'degraded';
  mode: ProviderName;
  providerConfigured: boolean;
  timestamp: string;
}

/** Structured provider error used internally before mapping. */
export interface ProviderFailure {
  category: ProviderErrorCategory;
  message: string;
  /** Raw provider task id, when present. */
  providerTaskId?: string;
}

/** Paginated list shape used by list endpoints. */
export interface ListResult<T> {
  items: T[];
  total: number;
}
