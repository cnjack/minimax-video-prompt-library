/**
 * Pure mapping between MiniMax-Hailuo-2.3 provider responses and the local job
 * state machine / error categories. Centralized so it can be exhaustively
 * unit-tested with a fake transport (no paid calls).
 *
 * Create contract (`POST {base}/v1/video_generation`):
 *   { task_id: "…", base_resp: { status_code: 0, status_msg: "success" } }
 *
 * Query contract (`GET {base}/v1/query/video_generation?task_id=…`):
 *   {
 *     task_id: "…",
 *     status: "Preparing" | "Queueing" | "Processing" | "Success" | "Fail",
 *     file_id: "…",                 // returned on Success
 *     base_resp: { status_code: 0, status_msg: "success" }
 *   }
 *
 * Retrieve contract (`GET {base}/v1/files/retrieve?file_id=…`):
 *   { file: { download_url: "https://…" }, base_resp: { status_code: 0, … } }
 *
 * Every response carries `base_resp`. A nonzero `status_code` is a typed
 * provider failure (see {@link classifyBaseResp}). The known codes are taken
 * from the official base_resp documentation:
 *   0 = success; 1002 = rate limit; 1004 = auth; 1026/1027 = sensitive content.
 */

import { isRetryableProviderCategory, ProviderErrorCategory } from '@h3/shared';
import type { JobStatus } from '@h3/shared';
import { ProviderError } from './types.js';

/**
 * Known MiniMax-Hailuo-2.3 task-status strings (flat top-level `status`),
 * mapped into the local state machine. The official "Preparing" and "Queueing"
 * states both collapse to local `queued`; "Processing" is `running`; "Success"
 * is `succeeded`; "Fail" is `failed`. An unknown status is treated
 * conservatively as `running` and the poller's bounded attempt budget
 * guarantees termination.
 */
const STATUS_TO_LOCAL: Record<string, JobStatus> = {
  preparing: 'queued',
  queueing: 'queued',
  processing: 'running',
  success: 'succeeded',
  fail: 'failed',
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

interface BaseResp {
  statusCode?: number;
  statusMsg?: string;
}

/** Read the flat `base_resp` object from any MiniMax response. */
export function readBaseResp(body: unknown): BaseResp {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const baseResp = (body as Record<string, unknown>).base_resp;
  if (!baseResp || typeof baseResp !== 'object') {
    return {};
  }
  const record = baseResp as Record<string, unknown>;
  const statusCode =
    typeof record.status_code === 'number' ? record.status_code : undefined;
  const statusMsg =
    typeof record.status_msg === 'string' ? record.status_msg : undefined;
  return { statusCode, statusMsg };
}

/** True when a response carries a nonzero `base_resp.status_code`. */
export function isBaseRespError(body: unknown): boolean {
  const { statusCode } = readBaseResp(body);
  return statusCode !== undefined && statusCode !== 0;
}

/**
 * Map a known MiniMax `base_resp.status_code` to a local error category.
 * Unrecognized nonzero codes collapse to `provider_failure`.
 */
export function classifyBaseResp(
  statusCode: number,
): ProviderErrorCategory {
  switch (statusCode) {
    case 1004:
      return ProviderErrorCategory.AUTH;
    case 1002:
      return ProviderErrorCategory.RATE_LIMIT;
    case 1026:
    case 1027:
      return ProviderErrorCategory.CONTENT_MODERATION;
    default:
      return ProviderErrorCategory.PROVIDER_FAILURE;
  }
}

/**
 * Build a typed failure from a response carrying a nonzero `base_resp`, using
 * the official status code taxonomy and the provider's status_msg. Returns
 * undefined when the response is not a base_resp error.
 */
export function baseRespFailure(body: unknown): {
  category: ProviderErrorCategory;
  message: string;
} | undefined {
  const { statusCode, statusMsg } = readBaseResp(body);
  if (statusCode === undefined || statusCode === 0) {
    return undefined;
  }
  return {
    category: classifyBaseResp(statusCode),
    message:
      statusMsg && statusMsg.trim().length > 0
        ? statusMsg
        : `MiniMax request failed (base_resp.status_code ${statusCode}).`,
  };
}

/** Extract the flat `task_id` from a create/query response. */
export function extractTaskId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.task_id === 'string' && record.task_id.length > 0) {
    return record.task_id;
  }
  return undefined;
}

/** Extract the flat `file_id` returned by a successful query response. */
export function extractFileId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.file_id === 'string' && record.file_id.length > 0) {
    return record.file_id;
  }
  if (typeof record.file_id === 'number' && Number.isFinite(record.file_id)) {
    return String(record.file_id);
  }
  return undefined;
}

/** Extract `file.download_url` from a /v1/files/retrieve response. */
export function extractDownloadUrl(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const file = (body as Record<string, unknown>).file;
  if (!file || typeof file !== 'object') {
    return undefined;
  }
  const url = (file as Record<string, unknown>).download_url;
  if (typeof url === 'string' && url.length > 0) {
    return url;
  }
  return undefined;
}

/** Read the flat top-level `status` string from a query response. */
function readRawStatus(body: unknown): unknown {
  if (body && typeof body === 'object') {
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
  /** Present only when the query already yielded a usable result. */
  resultUrl?: string;
  failure?: MappedQueryFailure;
}

/**
 * Map a query response body into the local job outcome.
 *
 * Read-path (transient) vs. genuine-terminal semantics are what protect an
 * ALREADY-PAID asynchronous job from being terminal-failed by a transient
 * read-path blip:
 *
 *  - A nonzero `base_resp` on the QUERY response, or on the file-retrieve
 *    response, whose category is RETRYABLE (rate_limit / provider_failure)
 *    THROWS a {@link ProviderError}. The poller catches it, RETAINS the queued/
 *    running row, and counts it against its bounded transient-failure budget.
 *    A single transient read-path failure therefore never becomes a local
 *    terminal `failed`; persistent read-path failure exhausts the budget into a
 *    recoverable `tracking_exhausted` (resumable, never a paid regeneration).
 *  - A Success response temporarily missing `file_id`, and a retrieve response
 *    temporarily missing `file.download_url`, likewise THROW (retryable) instead
 *    of immediately orphaning a paid result.
 *  - A nonzero `base_resp` whose category is DEFINITIVE (auth / moderation /
 *    balance / invalid request) on the read path is a genuine terminal `failed`.
 *  - A genuine provider task `Fail` status is a genuine terminal `failed`
 *    (the only outcome that warrants a paid Regenerate).
 */
export async function mapQueryResult(
  body: unknown,
  fileRetrieve: (fileId: string) => unknown | Promise<unknown> = () => undefined,
): Promise<MappedQueryResult> {
  const queryFailure = baseRespFailure(body);
  if (queryFailure) {
    if (isRetryableProviderCategory(queryFailure.category)) {
      throw new ProviderError(queryFailure.category, queryFailure.message);
    }
    return { status: 'failed', failure: queryFailure };
  }

  const status = mapTaskStatus(readRawStatus(body));

  if (status === 'succeeded') {
    const fileId = extractFileId(body);
    if (!fileId) {
      // Transient read-path gap on an already-paid Success: keep it retryable.
      throw new ProviderError(
        ProviderErrorCategory.PROVIDER_FAILURE,
        'MiniMax reported success but returned no file_id to retrieve yet.',
      );
    }
    const fileBody = await fileRetrieve(fileId);
    const retrieveFailure = baseRespFailure(fileBody);
    if (retrieveFailure) {
      if (isRetryableProviderCategory(retrieveFailure.category)) {
        throw new ProviderError(retrieveFailure.category, retrieveFailure.message);
      }
      return { status: 'failed', failure: retrieveFailure };
    }
    const downloadUrl = extractDownloadUrl(fileBody);
    if (!downloadUrl) {
      // Transient read-path gap: keep it retryable instead of orphaning a result.
      throw new ProviderError(
        ProviderErrorCategory.PROVIDER_FAILURE,
        'MiniMax returned no usable download URL for the result yet.',
      );
    }
    return { status: 'succeeded', resultUrl: downloadUrl };
  }

  if (status === 'failed') {
    // Genuine provider task `Fail` — a real terminal outcome (Regenerate).
    return {
      status: 'failed',
      failure: {
        category: ProviderErrorCategory.PROVIDER_FAILURE,
        message: 'MiniMax reported the task as failed.',
      },
    };
  }

  return { status };
}

function fallbackMessage(status: number, body: unknown): string {
  const base = baseRespFailure(body);
  if (base) {
    return base.message;
  }
  // Some non-base_resp error bodies (e.g. from a proxy/gateway) carry a
  // top-level `message`; surface it so the keyword heuristics below can fire.
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim().length > 0) {
      return m;
    }
  }
  return `MiniMax request failed with HTTP ${status}.`;
}

/**
 * Classify a non-2xx HTTP response. Prefers a nonzero `base_resp.status_code`
 * (the official error contract); otherwise maps the HTTP status and falls back
 * to message-keyword heuristics for variants that omit base_resp.
 */
export function classifyHttpFailure(failure: ProviderHttpFailure): {
  category: ProviderErrorCategory;
  message: string;
} {
  const { status, body } = failure;
  const base = baseRespFailure(body);
  if (base) {
    return base;
  }
  const message = fallbackMessage(status, body);

  if (status === 401) {
    return {
      category: ProviderErrorCategory.AUTH,
      message: message || 'Invalid or missing MiniMax credentials.',
    };
  }
  if (status === 402) {
    return {
      category: ProviderErrorCategory.INSUFFICIENT_BALANCE,
      message: message || 'Insufficient MiniMax credits.',
    };
  }
  if (status === 429) {
    return {
      category: ProviderErrorCategory.RATE_LIMIT,
      message: message || 'MiniMax rate limit reached.',
    };
  }
  if (status === 422) {
    return {
      category: ProviderErrorCategory.CONTENT_MODERATION,
      message: message || 'Content was rejected by MiniMax moderation.',
    };
  }

  // Message-keyword fallbacks for variants that omit a numeric status code.
  if (/balance|credit|insufficient|payment/i.test(message)) {
    return { category: ProviderErrorCategory.INSUFFICIENT_BALANCE, message };
  }
  if (/moderat|risk|sensitiv|content polic|not safe/i.test(message)) {
    return { category: ProviderErrorCategory.CONTENT_MODERATION, message };
  }
  if (/rate|quota|too many/i.test(message)) {
    return { category: ProviderErrorCategory.RATE_LIMIT, message };
  }
  if (/unauthor|invalid.*key|auth/i.test(message)) {
    return { category: ProviderErrorCategory.AUTH, message };
  }

  if (status >= 500) {
    return { category: ProviderErrorCategory.PROVIDER_FAILURE, message };
  }
  if (status >= 400 && status < 500) {
    return { category: ProviderErrorCategory.INVALID_REQUEST, message };
  }
  return { category: ProviderErrorCategory.PROVIDER_FAILURE, message };
}
