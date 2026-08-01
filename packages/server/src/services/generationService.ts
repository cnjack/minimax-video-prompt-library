/**
 * Generation-job domain logic: rendering, idempotency, provider submission,
 * retry, and retrieval. Renders the immutable version, enforces idempotency-key
 * uniqueness/conflict, and translates provider rejections into stable error
 * metadata on the job.
 */

import {
  createGenerationSchema,
  ErrorCode,
  MINIMAX_MAX_PROMPT_CHARS,
  MINIMAX_MODEL,
  ProviderErrorCategory,
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
import { ProviderError } from '../providers/types.js';
import type { MockScenario, VideoProvider } from '../providers/types.js';
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

    const renderedPrompt = this.resolveRenderedPrompt(
      version.content,
      request.values,
      request.prompt,
    );

    // Official MiniMax-Hailuo-2.3 contract: the `prompt` is capped at 2000 chars.
    // Enforce on the rendered prompt (after substitution or the supplied
    // override), server-side, BEFORE any job is created or the provider is
    // called.
    if (renderedPrompt.length > MINIMAX_MAX_PROMPT_CHARS) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        `The rendered prompt is ${renderedPrompt.length} characters; MiniMax-Hailuo-2.3 accepts at most ${MINIMAX_MAX_PROMPT_CHARS}.`,
        {
          status: 400,
          details: {
            length: renderedPrompt.length,
            limit: MINIMAX_MAX_PROMPT_CHARS,
          },
        },
      );
    }

    const payloadHash = computePayloadHash({
      promptVersionId: request.promptVersionId,
      values: request.values,
      prompt: request.prompt,
      durationSeconds: request.durationSeconds,
      resolution: request.resolution,
      firstFrameUrl: request.firstFrameUrl,
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
      prompt: request.prompt ?? null,
      durationSeconds: request.durationSeconds,
      resolution: request.resolution,
      firstFrameUrl: request.firstFrameUrl ?? null,
      mockScenario: request.mockScenario ?? null,
    };

    let job: GenerationJob;
    try {
      job = this.jobs.create({
        id: newId(),
        promptId: version.promptId,
        promptVersionId: version.id,
        renderedPrompt,
        model: MINIMAX_MODEL,
        durationSeconds: request.durationSeconds,
        // MiniMax-Hailuo-2.3 has no aspect-ratio parameter; the column is kept
        // for backward-compatible reads of historical jobs and stored as a
        // model-native sentinel for new jobs.
        aspectRatio: 'native',
        resolution: request.resolution,
        firstFrameUrl: request.firstFrameUrl ?? null,
        lastFrameUrl: null,
        referenceImageUrl: null,
        referenceVideoUrl: null,
        referenceAudioUrl: null,
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
        model: MINIMAX_MODEL,
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        firstFrameUrl: request.firstFrameUrl,
        mockScenario: request.mockScenario as MockScenario | undefined,
      });
      const updated = this.jobs.updateStatus(job.id, {
        providerTaskId: created.providerTaskId,
        status: created.status,
        resultUrl: created.resultUrl ?? null,
        now: nowIso(),
      });
      return { job: updated.job ?? job, reused: false };
    } catch (error) {
      const failure = this.toFailure(error);
      const updated = this.jobs.updateStatus(job.id, {
        status: 'failed',
        errorCode: failure.category,
        errorMessage: failure.message,
        now: nowIso(),
      });
      return { job: updated.job ?? job, reused: false };
    }
  }

  /**
   * Retry a failed/expired job as a brand-new job (history stays truthful).
   *
   * Idempotency is driven by an explicit per-attempt idempotency token supplied
   * by the caller (the client generates one token per button click). The token is
   * the idempotency key for the new job:
   *  - the SAME token reused while the HTTP outcome is unknown (e.g. a transport
   *    retry of the POST) resolves to the SAME retried job — never a second paid
   *    generation;
   *  - once the client observes a response it rotates the token, so a LATER
   *    deliberate retry of the same source supplies a NEW token and creates a
   *    distinct job.
   * This replaces the old derived `retry:<id>` key, which permanently mapped
   * every future retry of a source to the first retried job.
   *
   * The persisted generation parameters are re-validated against the shared
   * generation schema before resubmitting; a corrupt or legacy-incomplete row is
   * rejected with 422/UNPROCESSABLE rather than building an invalid provider
   * request.
   */
  async retry(jobId: string, idempotencyKey: string): Promise<CreateGenerationResult> {
    const original = this.requireJob(jobId);
    if (original.status !== 'failed' && original.status !== 'expired') {
      throw new ApiError(
        ErrorCode.UNPROCESSABLE,
        `Only failed or expired jobs can be retried (current status: ${original.status}).`,
        { status: 422 },
      );
    }

    const request = this.buildRetryRequest(original, idempotencyKey);
    const parsed = createGenerationSchema.safeParse(request);
    if (!parsed.success) {
      throw new ApiError(
        ErrorCode.UNPROCESSABLE,
        'The stored generation parameters for this job are invalid or incomplete ' +
          'and cannot be retried. Submit a new generation instead.',
        {
          status: 422,
          details: {
            issues: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        },
      );
    }
    return this.create(parsed.data);
  }

  /**
   * Reconstruct a generation request from a job's persisted parameters plus the
   * caller-supplied per-attempt idempotency token. Only MiniMax-Hailuo-2.3
   * supported fields are carried forward; legacy unsupported media (last frame,
   * reference image/video/audio) and the obsolete aspect-ratio parameter are
   * dropped so a retry targets the current model contract. An absent mock
   * scenario is omitted so the request round-trips through the shared schema.
   */
  private buildRetryRequest(
    original: GenerationJob,
    idempotencyKey: string,
  ): CreateGenerationRequest {
    const p = original.parameters as {
      values?: Record<string, string>;
      prompt?: string | null;
      durationSeconds?: number;
      resolution?: string;
      firstFrameUrl?: string | null;
      mockScenario?: MockScenario;
    };
    const request: Record<string, unknown> = {
      promptVersionId: original.promptVersionId,
      values: p.values ?? {},
      durationSeconds: p.durationSeconds,
      resolution: p.resolution,
      firstFrameUrl: p.firstFrameUrl ?? undefined,
      idempotencyKey,
    };
    if (p.prompt && p.prompt.length > 0) {
      request.prompt = p.prompt;
    }
    if (p.mockScenario) {
      request.mockScenario = p.mockScenario;
    }
    return request as CreateGenerationRequest;
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

  /**
   * Determine the final prompt text item. A non-blank client-supplied `prompt`
   * override (e.g. the rendered prompt with inserted camera-motion cues) is used
   * verbatim; otherwise the immutable version is rendered with `values`. Either
   * way the result is subject to the H3 rendered-character limit by the caller.
   *
   * The immutable version is ALWAYS rendered/validated with `values` first —
   * even when a non-blank override is supplied — so unresolved variables and
   * template syntax errors still fail BEFORE any job is created or the provider
   * is called. The validated override then remains the final rendered prompt.
   * The route layer trims the override via the schema; the `.trim()` guard here
   * also protects direct/retry callers that may supply a whitespace-only value.
   */
  private resolveRenderedPrompt(
    content: string,
    values: Record<string, string>,
    promptOverride: string | undefined,
  ): string {
    const renderedFromVersion = this.renderOrFail(content, values);
    if (promptOverride !== undefined && promptOverride.trim().length > 0) {
      return promptOverride;
    }
    return renderedFromVersion;
  }

  /**
   * Translate a submission error into a single, consistent error vocabulary: a
   * `ProviderErrorCategory` value (stored on `generation_jobs.error_code`). A
   * non-ProviderError (unknown synchronous failure) maps to
   * `provider_failure` — never the HTTP-envelope code `provider_error`, so the
   * persisted column always holds a ProviderErrorCategory.
   */
  private toFailure(error: unknown): {
    category: ProviderErrorCategory;
    message: string;
  } {
    if (error instanceof ProviderError) {
      return { category: error.category, message: error.message };
    }
    return {
      category: ProviderErrorCategory.PROVIDER_FAILURE,
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
