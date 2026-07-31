/**
 * Generation-job repository. Owns the job state machine persistence and the
 * idempotency-key uniqueness constraint. Idempotency resolution (reuse vs.
 * conflict) is implemented in the generation service using these primitives.
 */

import type {
  GenerationJob,
  JobStatus,
  ProviderName,
} from '@h3/shared';
import type { ListJobsQuery } from '@h3/shared';
import type { DB, SqlBind } from '../client.js';

interface JobRow {
  id: string;
  prompt_id: string;
  prompt_version_id: string;
  rendered_prompt: string;
  model: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  first_frame_url: string | null;
  last_frame_url: string | null;
  reference_image_url: string | null;
  reference_video_url: string | null;
  reference_audio_url: string | null;
  status: JobStatus;
  provider: ProviderName;
  provider_task_id: string | null;
  result_url: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  idempotency_payload_hash: string;
  parameters: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapRow(row: JobRow): GenerationJob {
  let parameters: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.parameters) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parameters = parsed as Record<string, unknown>;
    }
  } catch {
    parameters = {};
  }
  return {
    id: row.id,
    promptId: row.prompt_id,
    promptVersionId: row.prompt_version_id,
    renderedPrompt: row.rendered_prompt,
    model: row.model,
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    resolution: row.resolution,
    firstFrameUrl: row.first_frame_url,
    lastFrameUrl: row.last_frame_url,
    referenceImageUrl: row.reference_image_url,
    referenceVideoUrl: row.reference_video_url,
    referenceAudioUrl: row.reference_audio_url,
    status: row.status,
    provider: row.provider,
    providerTaskId: row.provider_task_id,
    resultUrl: row.result_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    idempotencyPayloadHash: row.idempotency_payload_hash,
    parameters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface CreateJobInput {
  id: string;
  promptId: string;
  promptVersionId: string;
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
  resultUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  idempotencyPayloadHash: string;
  parameters: Record<string, unknown>;
  now: string;
}

const TERMINAL_STATUSES = ['succeeded', 'failed', 'expired'];

export class JobRepository {
  constructor(private readonly db: DB) {}

  create(input: CreateJobInput): GenerationJob {
    this.db
      .prepare(
        `INSERT INTO generation_jobs
           (id, prompt_id, prompt_version_id, rendered_prompt, model,
            duration_seconds, aspect_ratio, resolution,
            first_frame_url, last_frame_url, reference_image_url,
            reference_video_url, reference_audio_url,
            status, provider, provider_task_id, result_url,
            error_code, error_message, idempotency_key, idempotency_payload_hash,
            parameters, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.promptId,
        input.promptVersionId,
        input.renderedPrompt,
        input.model,
        input.durationSeconds,
        input.aspectRatio,
        input.resolution,
        input.firstFrameUrl,
        input.lastFrameUrl,
        input.referenceImageUrl,
        input.referenceVideoUrl,
        input.referenceAudioUrl,
        input.status,
        input.provider,
        input.providerTaskId,
        input.resultUrl,
        input.errorCode,
        input.errorMessage,
        input.idempotencyKey,
        input.idempotencyPayloadHash,
        JSON.stringify(input.parameters),
        input.now,
        input.now,
      );
    return this.getById(input.id) as GenerationJob;
  }

  getById(id: string): GenerationJob | null {
    const row = this.db
      .prepare('SELECT * FROM generation_jobs WHERE id = ?')
      .get(id) as JobRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByIdempotencyKey(key: string): GenerationJob | null {
    const row = this.db
      .prepare('SELECT * FROM generation_jobs WHERE idempotency_key = ?')
      .get(key) as JobRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(query: ListJobsQuery): GenerationJob[] {
    const where: string[] = [];
    const params: SqlBind = [];
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.promptId) {
      where.push('prompt_id = ?');
      params.push(query.promptId);
    }
    const sql = `SELECT * FROM generation_jobs
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?`;
    params.push(query.limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as JobRow[];
    return rows.map(mapRow);
  }

  listByPrompt(promptId: string): GenerationJob[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM generation_jobs WHERE prompt_id = ? ORDER BY created_at DESC',
      )
      .all(promptId) as unknown as JobRow[];
    return rows.map(mapRow);
  }

  /** Non-terminal jobs the poller should advance. */
  listNonTerminal(): GenerationJob[] {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM generation_jobs WHERE status NOT IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .all(...TERMINAL_STATUSES) as unknown as JobRow[];
    return rows.map(mapRow);
  }

  /**
   * Apply a status/field update with a compare-and-set guard.
   *
   * A NON-TERMINAL target status (queued/running) is only written when the row is
   * itself non-terminal, so a stale poll (or any non-terminal write) can never
   * revive an already-terminal (succeeded/failed/expired) row back to
   * queued/running. Terminal target statuses are always applied (re-asserting a
   * terminal state is idempotent).
   *
   * Returns the resulting row plus a `lostUpdate` flag that is true when a
   * non-terminal update was refused because the row was already terminal (the
   * returned `job` is then the unchanged terminal row). Callers (the poller) must
   * treat `lostUpdate` as a safe no-op rather than overwriting state.
   */
  updateStatus(id: string, update: JobStatusUpdate): UpdateStatusOutcome {
    const setClauses: string[] = ['updated_at = ?'];
    const setParams: SqlBind = [update.now];
    if (update.status !== undefined) {
      setClauses.push('status = ?');
      setParams.push(update.status);
    }
    if (update.providerTaskId !== undefined) {
      setClauses.push('provider_task_id = ?');
      setParams.push(update.providerTaskId);
    }
    if (update.resultUrl !== undefined) {
      setClauses.push('result_url = ?');
      setParams.push(update.resultUrl);
    }
    if (update.errorCode !== undefined) {
      setClauses.push('error_code = ?');
      setParams.push(update.errorCode);
    }
    if (update.errorMessage !== undefined) {
      setClauses.push('error_message = ?');
      setParams.push(update.errorMessage);
    }
    const isTerminal =
      update.status !== undefined && TERMINAL_STATUSES.includes(update.status);
    if (isTerminal) {
      setClauses.push('completed_at = ?');
      setParams.push(update.now);
    }

    // Compare-and-set guard: a non-terminal target only applies to a row that is
    // currently non-terminal. This prevents a stale non-terminal update from
    // moving an already-terminal row back to queued/running.
    const targetIsNonTerminal =
      update.status !== undefined && !TERMINAL_STATUSES.includes(update.status);
    const guardClause = targetIsNonTerminal
      ? ` AND status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})`
      : '';
    const guardParams: SqlBind = targetIsNonTerminal ? [...TERMINAL_STATUSES] : [];

    const info = this.db
      .prepare(
        `UPDATE generation_jobs SET ${setClauses.join(', ')} WHERE id = ?${guardClause}`,
      )
      // Placeholder order matches the SQL: SET params, then the row id, then the
      // CAS guard params (terminal statuses).
      .run(...setParams, id, ...guardParams) as { changes?: number };

    const row = this.getById(id);
    const lostUpdate = targetIsNonTerminal && (info.changes ?? 1) === 0;
    return { job: row, lostUpdate };
  }

  /** Reset transient-failure attempt counters (stored on the job row params). */
  setParameters(id: string, parameters: Record<string, unknown>, now: string): void {
    this.db
      .prepare(
        'UPDATE generation_jobs SET parameters = ?, updated_at = ? WHERE id = ?',
      )
      .run(JSON.stringify(parameters), now, id);
  }

  /**
   * Recover orphaned jobs left queued/running with no provider task after a
   * process interruption. Such a job never reached (or never recorded) a
   * provider submission, so it must not be polled forever. It is moved to an
   * explicit recoverable `failed` state on startup; the user can retry it as a
   * new job.
   *
   * Returns the ids of the recovered jobs so callers can log/count them.
   */
  recoverUnsubmitted(now: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM generation_jobs
          WHERE status IN ('queued', 'running') AND provider_task_id IS NULL`,
      )
      .all() as unknown as Array<{ id: string }>;
    if (rows.length === 0) {
      return [];
    }
    const recovered: string[] = [];
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE generation_jobs
             SET status = 'failed',
                 error_code = 'provider_failure',
                 error_message = ?,
                 updated_at = ?,
                 completed_at = ?
           WHERE id = ?`,
        )
        .run(
          'Job was interrupted before its provider submission completed. ' +
            'Retry to regenerate.',
          now,
          now,
          row.id,
        );
      recovered.push(row.id);
    }
    return recovered;
  }
}

export interface JobStatusUpdate {
  status?: JobStatus;
  providerTaskId?: string;
  resultUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now: string;
}

/**
 * Outcome of a compare-and-set {@link JobRepository.updateStatus}.
 *  - `job`: the row as it exists after the attempted update (null if not found).
 *  - `lostUpdate`: true when a non-terminal update was refused because the row
 *    was already terminal; `job` is then the unchanged terminal row.
 */
export interface UpdateStatusOutcome {
  job: GenerationJob | null;
  lostUpdate: boolean;
}
