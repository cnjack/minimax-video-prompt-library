/**
 * Pure mapping between MiniMax provider responses and the local job state
 * machine / error categories. Centralized so it can be exhaustively unit-tested
 * with a fake transport.
 */

import { ProviderErrorCategory } from '@h3/shared';
import type { JobStatus } from '@h3/shared';

/**
 * Known MiniMax task-status strings. The provider may return others; unknown
 * values map conservatively to "running" so the poller keeps trying until a
 * terminal status arrives or the attempt budget is exhausted.
 */
const STATUS_TO_LOCAL: Record<string, JobStatus> = {
  // Preparing / processing states.
  prepare: 'running',
  preparing: 'running',
  processing: 'running',
  queued: 'queued',
  pending: 'queued',
  // Terminal success.
  success: 'succeeded',
  succeeded: 'succeeded',
  // Terminal failure.
  fail: 'failed',
  failed: 'failed',
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

export interface MinimaxBaseResp {
  status_code?: number;
  status_msg?: string;
}

export interface ProviderHttpFailure {
  status: number;
  /** Raw decoded body for inspection. */
  body: unknown;
}

/**
 * Classify a non-2xx HTTP response into a provider error category. Mirrors the
 * common MiniMax error envelope `{ base_resp: { status_code, status_msg } }`
 * while also handling plain HTTP status codes.
 */
export function classifyHttpFailure(failure: ProviderHttpFailure): {
  category: ProviderErrorCategory;
  message: string;
} {
  const { status, body } = failure;
  const baseResp = readBaseResp(body);
  const status_code = baseResp?.status_code ?? status;
  const message =
    baseResp?.status_msg ??
    (typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message?: unknown }).message)
      : `MiniMax request failed with HTTP ${status}.`);

  // MiniMax status_code conventions for video generation.
  if (status_code === 1004 || status_code === 1027 || status === 401) {
    return { category: ProviderErrorCategory.AUTH, message: message || 'Invalid or missing MiniMax credentials.' };
  }
  if (status_code === 1022 || /balance|credit|insufficient/i.test(message)) {
    return {
      category: ProviderErrorCategory.INSUFFICIENT_BALANCE,
      message: message || 'Insufficient MiniMax credits.',
    };
  }
  if (
    status_code === 1008 ||
    status_code === 1024 ||
    /moderat|risk|sensitiv|content polic/i.test(message)
  ) {
    return {
      category: ProviderErrorCategory.CONTENT_MODERATION,
      message: message || 'Content was rejected by MiniMax moderation.',
    };
  }
  if (status_code === 1039 || status === 429 || /rate|quota|too many/i.test(message)) {
    return {
      category: ProviderErrorCategory.RATE_LIMIT,
      message: message || 'MiniMax rate limit reached.',
    };
  }
  if (status >= 400 && status < 500) {
    return { category: ProviderErrorCategory.INVALID_REQUEST, message };
  }
  return { category: ProviderErrorCategory.PROVIDER_FAILURE, message };
}

function readBaseResp(body: unknown): MinimaxBaseResp | undefined {
  if (body && typeof body === 'object' && 'base_resp' in body) {
    const br = (body as { base_resp?: unknown }).base_resp;
    if (br && typeof br === 'object') {
      return br as MinimaxBaseResp;
    }
  }
  return undefined;
}

/** Extract a download/result URL from a successful query response. */
export function extractResultUrl(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const candidate =
    record.download_url ??
    record.video_url ??
    record.file_id ??
    (Array.isArray(record.videos) && record.videos[0]
      ? (record.videos[0] as Record<string, unknown>).url ??
        (record.videos[0] as Record<string, unknown>).download_url
      : undefined);
  return typeof candidate === 'string' ? candidate : undefined;
}

/** Extract the provider task id from a create/query response. */
export function extractTaskId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const candidate = record.task_id ?? record.id;
  return typeof candidate === 'string' ? candidate : undefined;
}
