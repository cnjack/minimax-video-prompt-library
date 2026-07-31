/**
 * Pure mapping between MiniMax H3 V2 provider responses and the local job state
 * machine / error categories. Centralized so it can be exhaustively unit-tested
 * with a fake transport (no paid calls).
 *
 * Query contract (`GET {base}/v2/query/video_generation/{task_id}`):
 *   {
 *     task: {
 *       status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired',
 *       content: { url },          // present on success
 *       error:   { type?, message?, code? }  // present on failure
 *     }
 *   }
 *
 * Error contract (OpenAI-style envelope on non-2xx):
 *   { type: 'error', error: { type, message, http_code }, request_id }
 */

import { ProviderErrorCategory } from '@h3/shared';
import type { JobStatus } from '@h3/shared';

/**
 * Known MiniMax H3 V2 task-status strings, mapped into the local state
 * machine. `cancelled` is a terminal state mapped to local `failed` so polling
 * can never spin on it forever; an unknown status is treated conservatively as
 * `running` and the poller's bounded attempt budget guarantees termination.
 */
const STATUS_TO_LOCAL: Record<string, JobStatus> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  success: 'succeeded',
  failed: 'failed',
  fail: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  expired: 'expired',
};

export function mapTaskStatus(raw: unknown): JobStatus {
  if (typeof raw !== 'string') {
    return 'running';
  }
  const normalized = raw.trim().toLowerCase();
  return STATUS_TO_LOCAL[normalized] ?? 'running';
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'expired';
}

export interface ProviderHttpFailure {
  status: number;
  /** Raw decoded body for inspection. */
  body: unknown;
}

/** Read the nested `task` object from a query response, tolerating depth. */
function readTask(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (record.task && typeof record.task === 'object') {
      return record.task as Record<string, unknown>;
    }
    // Tolerate a flat response (task fields at the top level).
    if ('status' in record || 'content' in record || 'error' in record) {
      return record;
    }
  }
  return undefined;
}

/** Extract a download/result URL from a successful query response. */
export function extractResultUrl(body: unknown): string | undefined {
  const task = readTask(body);
  if (!task) {
    return undefined;
  }
  // Preferred H3 V2 location: task.content.url.
  const content = task.content;
  if (content && typeof content === 'object') {
    const url = (content as Record<string, unknown>).url;
    if (typeof url === 'string' && url.length > 0) {
      return url;
    }
  }
  // Defensive fallbacks for variant envelopes.
  const direct =
    (typeof task.download_url === 'string' && task.download_url) ||
    (typeof task.video_url === 'string' && task.video_url) ||
    undefined;
  return direct;
}

/** Extract provider failure details (task.error) from a failed/expired query. */
export function extractTaskFailure(
  body: unknown,
): { message: string; code?: string | number } | undefined {
  const task = readTask(body);
  if (!task) {
    return undefined;
  }
  const error = task.error;
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const message =
    (typeof record.message === 'string' && record.message) ||
    (typeof record.reason === 'string' && record.reason) ||
    'The provider reported a task failure.';
  const code = typeof record.code === 'string' || typeof record.code === 'number'
    ? record.code
    : undefined;
  return { message, code };
}

/**
 * Read the raw task status string from a query response (nested `task.status`
 * or a flat top-level `status`), tolerating either envelope shape.
 */
function readRawStatus(body: unknown): unknown {
  const task = readTask(body);
  if (task && 'status' in task) {
    return task.status;
  }
  if (body && typeof body === 'object' && 'status' in body) {
    return (body as Record<string, unknown>).status;
  }
  return undefined;
}

export interface MappedQueryFailure {
  category: ProviderErrorCategory;
  message: string;
}

export interface MappedQueryResult {
  status: JobStatus;
  resultUrl?: string;
  failure?: MappedQueryFailure;
}

/**
 * Classify an async `task.error` from a query response into the local provider
 * error taxonomy, preserving the provider's stable code/message signal instead
 * of always collapsing to `provider_failure`.
 *
 * MiniMax surfaces failure reason via `task.error.code` (a string/number) and/or
 * `task.error.message`. We map the known stable families (moderation, balance,
 * rate-limit, auth, invalid request) using the code plus message keywords, and
 * fall back to `provider_failure` for anything unrecognized.
 */
export function classifyTaskFailureCategory(
  failure: { message: string; code?: string | number },
): ProviderErrorCategory {
  const code = failure.code !== undefined ? String(failure.code) : '';
  const text = `${code} ${failure.message}`.toLowerCase();

  if (/balance|credit|insufficient|payment|402/.test(text)) {
    return ProviderErrorCategory.INSUFFICIENT_BALANCE;
  }
  if (/moderat|risk|sensitiv|content polic|not safe|safety|422/.test(text)) {
    return ProviderErrorCategory.CONTENT_MODERATION;
  }
  if (/rate|quota|too many|429/.test(text)) {
    return ProviderErrorCategory.RATE_LIMIT;
  }
  if (/unauthor|invalid.*key|invalid.*token|auth|401/.test(text)) {
    return ProviderErrorCategory.AUTH;
  }
  if (/invalid|bad request|malformed|400/.test(text)) {
    return ProviderErrorCategory.INVALID_REQUEST;
  }
  return ProviderErrorCategory.PROVIDER_FAILURE;
}

/**
 * Map a full query response body into the local job outcome: status, optional
 * result URL, and optional provider failure.
 *
 * Two correctness guarantees over the raw extractors:
 *  1. A provider `succeeded` status without a usable result URL is converted to
 *     a RECOVERABLE provider failure (local `failed`), so the job never ends up
 *     as an unretryable `succeeded` row with a null `resultUrl`. The user can
 *     retry it as a new job.
 *  2. An async `task.error` is classified by its stable provider code (via
 *     {@link classifyTaskFailureCategory}) rather than always `provider_failure`.
 */
export function mapQueryResult(body: unknown): MappedQueryResult {
  const status = mapTaskStatus(readRawStatus(body));
  const resultUrl = extractResultUrl(body);

  if (status === 'succeeded' && !resultUrl) {
    return {
      status: 'failed',
      failure: {
        category: ProviderErrorCategory.PROVIDER_FAILURE,
        message:
          'The provider reported success but returned no usable result URL.',
      },
    };
  }

  const taskFailure = extractTaskFailure(body);
  const failure: MappedQueryFailure | undefined = taskFailure
    ? {
        category: classifyTaskFailureCategory(taskFailure),
        message: taskFailure.message,
      }
    : undefined;

  return {
    status,
    ...(resultUrl ? { resultUrl } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Extract the provider task id from a create/query response. */
export function extractTaskId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  // Preferred locations, in order of the documented contract.
  if (typeof record.task_id === 'string' && record.task_id.length > 0) {
    return record.task_id;
  }
  const task = record.task;
  if (task && typeof task === 'object') {
    const innerId = (task as Record<string, unknown>).task_id;
    if (typeof innerId === 'string' && innerId.length > 0) {
      return innerId;
    }
  }
  if (typeof record.id === 'string' && record.id.length > 0) {
    return record.id;
  }
  return undefined;
}

interface ParsedErrorEnvelope {
  httpCode?: number;
  message?: string;
  errorType?: string;
}

/** Read the OpenAI-style error envelope `{ error: { type, message, http_code } }`. */
function readErrorEnvelope(body: unknown): ParsedErrorEnvelope {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    const httpCode = typeof err.http_code === 'number' ? err.http_code : undefined;
    const message = typeof err.message === 'string' ? err.message : undefined;
    const errorType = typeof err.type === 'string' ? err.type : undefined;
    if (httpCode !== undefined || message !== undefined || errorType !== undefined) {
      return { httpCode, message, errorType };
    }
  }
  return {};
}

function fallbackMessage(status: number, body: unknown): string {
  const env = readErrorEnvelope(body);
  if (env.message) {
    return env.message;
  }
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string') {
      return m;
    }
  }
  return `MiniMax request failed with HTTP ${status}.`;
}

/**
 * Classify a non-2xx HTTP response into a provider error category using the
 * OpenAI-style error envelope's `http_code` (falling back to the HTTP status)
 * plus message-keyword heuristics. Maps 400/401/402/422/429/500/529 explicitly.
 */
export function classifyHttpFailure(failure: ProviderHttpFailure): {
  category: ProviderErrorCategory;
  message: string;
} {
  const { status, body } = failure;
  const envelope = readErrorEnvelope(body);
  const httpCode = envelope.httpCode ?? status;
  const message = fallbackMessage(status, body);

  // Prefer explicit HTTP semantics (per the documented contract).
  if (httpCode === 401) {
    return {
      category: ProviderErrorCategory.AUTH,
      message: message || 'Invalid or missing MiniMax credentials.',
    };
  }
  if (httpCode === 402) {
    return {
      category: ProviderErrorCategory.INSUFFICIENT_BALANCE,
      message: message || 'Insufficient MiniMax credits.',
    };
  }
  if (httpCode === 429) {
    return {
      category: ProviderErrorCategory.RATE_LIMIT,
      message: message || 'MiniMax rate limit reached.',
    };
  }
  if (httpCode === 422) {
    return {
      category: ProviderErrorCategory.CONTENT_MODERATION,
      message: message || 'Content was rejected by MiniMax moderation.',
    };
  }
  if (httpCode === 500 || httpCode === 529) {
    return {
      category: ProviderErrorCategory.PROVIDER_FAILURE,
      message: message || 'MiniMax service error.',
    };
  }
  if (httpCode === 400) {
    return { category: ProviderErrorCategory.INVALID_REQUEST, message };
  }

  // Message-keyword fallbacks for variants that omit a numeric http_code.
  if (/balance|credit|insufficient|payment/i.test(message)) {
    return {
      category: ProviderErrorCategory.INSUFFICIENT_BALANCE,
      message,
    };
  }
  if (/moderat|risk|sensitiv|content polic|not safe/i.test(message)) {
    return {
      category: ProviderErrorCategory.CONTENT_MODERATION,
      message,
    };
  }
  if (/rate|quota|too many/i.test(message)) {
    return {
      category: ProviderErrorCategory.RATE_LIMIT,
      message,
    };
  }
  if (/unauthor|invalid.*key|auth/i.test(message)) {
    return {
      category: ProviderErrorCategory.AUTH,
      message,
    };
  }

  if (httpCode >= 400 && httpCode < 500) {
    return { category: ProviderErrorCategory.INVALID_REQUEST, message };
  }
  return { category: ProviderErrorCategory.PROVIDER_FAILURE, message };
}
