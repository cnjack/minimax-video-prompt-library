/**
 * Generation-job domain logic: rendering, idempotency, provider submission,
 * retry, and retrieval. Renders the immutable version, enforces idempotency-key
 * uniqueness/conflict, and translates provider rejections into stable error
 * metadata on the job.
 */

import {
  categoryToErrorCode,
  ErrorCode,
  H3_MAX_PROMPT_CHARS,
  H3_MODEL,
  renderTemplate,
  TemplateSyntaxError,
  UnresolvedVariableError,
  type CreateGenerationRequest,
  type GenerationJob,
  type ProviderName,
} from '@h3/shared';
import type { JobRepository } from '../db/repositories/jobRepo.js';
import type { VersionRepository } from '../db/repositories/versionRepo.js';
import { ApiError } from '../errors.js';
import type { VideoProvider, ProviderError, MockScenario } from '../providers/types.js';
import { computePayloadHash, isUniqueConstraintError, newId, nowIso } from '../util.js';

export interface CreateGenerationResult {
  job: GenerationJob;
  reused: boolean;
}

export class GenerationService {
  constructor(
    private readonly versions: VersionRepository,
    private readonly jobs: JobRepository,
    private readonly provider: VideoProvider,
    private readonly providerMode: ProviderName,
  ) {}

  async create(request: CreateGenerationRequest): Promise<CreateGenerationResult> {
    const version = this.versions.getById(request.promptVersionId);
    if (!version) {
      throw new ApiError(
        ErrorCode.NOT_FOUND,
        `Prompt version ${request.promptVersionId} not found.`,
      );
    }

    const renderedPrompt = this.renderOrFail(version.content, request.values);

    // Official H3 contract: the text item is capped at 7000 chars. Enforce on
    // the rendered prompt (after substitution), server-side, BEFORE any job is
    // created or the provider is called.
    if (renderedPrompt.length > H3_MAX_PROMPT_CHARS) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        `The rendered prompt is ${renderedPrompt.length} characters; MiniMax H3 accepts at most ${H3_MAX_PROMPT_CHARS}.`,
        {
          status: 400,
          details: {
            length: renderedPrompt.length,
            limit: H3_MAX_PROMPT_CHARS,
          },
        },
      );
    }

    const payloadHash = computePayloadHash({
      promptVersionId: request.promptVersionId,
      values: request.values,
      durationSeconds: request.durationSeconds,
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      firstFrameUrl: request.firstFrameUrl,
      lastFrameUrl: request.lastFrameUrl,
      referenceImageUrl: request.referenceImageUrl,
      referenceVideoUrl: request.referenceVideoUrl,
      referenceAudioUrl: request.referenceAudioUrl,
    });

    const idempotencyKey = request.idempotencyKey ?? newId();

    // Idempotency: same key + same payload reuses; different payload conflicts.
    const existing = this.jobs.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.idempotencyPayloadHash !== payloadHash) {
        throw new ApiError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          'An idempotency key was reused with a different request payload.',
          { status: 409 },
        );
      }
      return { job: existing, reused: true };
    }

    const now = nowIso();
    const parameters = {
      values: request.values,
      durationSeconds: request.durationSeconds,
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      firstFrameUrl: request.firstFrameUrl ?? null,
      lastFrameUrl: request.lastFrameUrl ?? null,
      referenceImageUrl: request.referenceImageUrl ?? null,
      referenceVideoUrl: request.referenceVideoUrl ?? null,
      referenceAudioUrl: request.referenceAudioUrl ?? null,
      mockScenario: request.mockScenario ?? null,
    };

    let job: GenerationJob;
    try {
      job = this.jobs.create({
        id: newId(),
        promptId: version.promptId,
        promptVersionId: version.id,
        renderedPrompt,
        model: H3_MODEL,
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        firstFrameUrl: request.firstFrameUrl ?? null,
        lastFrameUrl: request.lastFrameUrl ?? null,
        referenceImageUrl: request.referenceImageUrl ?? null,
        referenceVideoUrl: request.referenceVideoUrl ?? null,
        referenceAudioUrl: request.referenceAudioUrl ?? null,
        status: 'queued',
        provider: this.providerMode,
        providerTaskId: null,
        resultUrl: null,
        errorCode: null,
        errorMessage: null,
        idempotencyKey,
        idempotencyPayloadHash: payloadHash,
        parameters,
        now,
      });
    } catch (dbError) {
      // Concurrency: a concurrent request with the same idempotency key won the
      // UNIQUE insert race. Re-resolve into reuse (same payload) or 409
      // (different payload) instead of surfacing a generic 500. The winner
      // owns the single submission, so we must NOT call the provider here.
      if (isUniqueConstraintError(dbError)) {
        const raced = this.jobs.findByIdempotencyKey(idempotencyKey);
        if (raced) {
          if (raced.idempotencyPayloadHash !== payloadHash) {
            throw new ApiError(
              ErrorCode.IDEMPOTENCY_CONFLICT,
              'An idempotency key was reused with a different request payload.',
              { status: 409 },
            );
          }
          return { job: raced, reused: true };
        }
      }
      throw dbError;
    }

    // Submit to the provider. On rejection, mark the job terminally failed.
    try {
      const created = await this.provider.create({
        renderedPrompt,
        model: H3_MODEL,
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        firstFrameUrl: request.firstFrameUrl,
        lastFrameUrl: request.lastFrameUrl,
        referenceImageUrl: request.referenceImageUrl,
        referenceVideoUrl: request.referenceVideoUrl,
        referenceAudioUrl: request.referenceAudioUrl,
        mockScenario: request.mockScenario as MockScenario | undefined,
      });
      const updated = this.jobs.updateStatus(job.id, {
        providerTaskId: created.providerTaskId,
        status: created.status,
        resultUrl: created.resultUrl ?? null,
        now: nowIso(),
      });
      return { job: updated ?? job, reused: false };
    } catch (error) {
      const failure = this.toFailure(error);
      const updated = this.jobs.updateStatus(job.id, {
        status: 'failed',
        errorCode: failure.category,
        errorMessage: failure.message,
        now: nowIso(),
      });
      return { job: updated ?? job, reused: false };
    }
  }

  /** Retry a failed/expired job as a brand-new job (history stays truthful). */
  async retry(jobId: string): Promise<CreateGenerationResult> {
    const original = this.requireJob(jobId);
    if (original.status !== 'failed' && original.status !== 'expired') {
      throw new ApiError(
        ErrorCode.UNPROCESSABLE,
        `Only failed or expired jobs can be retried (current status: ${original.status}).`,
        { status: 422 },
      );
    }
    const params = original.parameters as {
      values: Record<string, string>;
      durationSeconds: number;
      aspectRatio: string;
      resolution: string;
      firstFrameUrl?: string;
      lastFrameUrl?: string;
      referenceImageUrl?: string;
      referenceVideoUrl?: string;
      referenceAudioUrl?: string;
      mockScenario?: MockScenario;
    };
    // Fresh idempotency key => always a new job.
    return this.create({
      promptVersionId: original.promptVersionId,
      values: params.values ?? {},
      durationSeconds: params.durationSeconds,
      aspectRatio: params.aspectRatio as CreateGenerationRequest['aspectRatio'],
      resolution: params.resolution as CreateGenerationRequest['resolution'],
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      referenceImageUrl: params.referenceImageUrl,
      referenceVideoUrl: params.referenceVideoUrl,
      referenceAudioUrl: params.referenceAudioUrl,
      mockScenario: params.mockScenario,
    });
  }

  getById(id: string): GenerationJob {
    return this.requireJob(id);
  }

  list(query: {
    status?: GenerationJob['status'];
    promptId?: string;
    limit: number;
  }): GenerationJob[] {
    return this.jobs.list(query);
  }

  private renderOrFail(content: string, values: Record<string, string>): string {
    try {
      return renderTemplate(content, values);
    } catch (error) {
      if (error instanceof UnresolvedVariableError) {
        throw new ApiError(ErrorCode.UNRESOLVED_VARIABLE, error.message, {
          status: 400,
          details: { variable: error.variable },
        });
      }
      if (error instanceof TemplateSyntaxError) {
        throw new ApiError(ErrorCode.INVALID_TEMPLATE, error.message, {
          status: 400,
          details: { raw: error.raw },
        });
      }
      throw error;
    }
  }

  private toFailure(error: unknown): { category: string; message: string } {
    if (error instanceof Error && 'category' in error) {
      const providerError = error as ProviderError;
      return {
        category: providerError.category,
        message: providerError.message,
      };
    }
    return {
      category: categoryToErrorCode('provider_failure'),
      message: 'Generation failed for an unknown reason.',
    };
  }

  private requireJob(id: string): GenerationJob {
    const job = this.jobs.getById(id);
    if (!job) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Job ${id} not found.`);
    }
    return job;
  }
}
