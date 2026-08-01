/**
 * Typed API client. A thin fetch wrapper over the REST surface. Imports shared
 * contract types only — never the server implementation. Errors are normalized
 * into `ApiClientError` carrying the stable error code and request id.
 */

import type {
  CreateGenerationRequest,
  CreatePromptRequest,
  DuplicatePromptRequest,
  GenerationJob,
  HealthStatus,
  ListJobsQuery,
  ListPromptsQuery,
  Prompt,
  PromptDetail,
  PromptVersion,
  UpdatePromptRequest,
} from '@h3/shared';
import type {
  ApiErrorBody,
  CreateGenerationResponse,
} from '@h3/shared';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiClientError';
    this.code = body.code;
    this.status = body.status;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

export interface ListResponse<T> {
  items: T[];
  total: number;
}

interface RequestOptions {
  method: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Extra request headers (e.g. a per-attempt Idempotency-Key). */
  headers?: Record<string, string>;
  /** Optional abort signal so callers can cancel in-flight requests. */
  signal?: AbortSignal;
}

/** Options accepted by list-style reads. */
export interface ReadOptions {
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const url = options.query
    ? `${path}?${new URLSearchParams(
        Object.entries(options.query).filter(([, v]) => v !== undefined) as [string, string][],
      ).toString()}`
    : path;

  const headers: Record<string, string> = options.headers ?? {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const text = await response.text();
  // Tolerate non-JSON bodies without leaking a raw SyntaxError. A parse failure
  // becomes a structured ApiClientError carrying the status and request id.
  let parsed: unknown;
  let parseFailed = false;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
      parseFailed = true;
    }
  } else {
    parsed = undefined;
  }

  if (!response.ok || parseFailed) {
    const errorBody = !parseFailed
      ? (parsed as { error?: ApiErrorBody } | undefined)?.error
      : undefined;
    throw new ApiClientError(
      errorBody ?? {
        code: 'internal_error',
        message: parseFailed
          ? `Received a non-JSON response with status ${response.status}.`
          : `Request failed with status ${response.status}.`,
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? 'unknown',
      },
    );
  }
  return parsed as T;
}

export const api = {
  // Prompts
  listPrompts(
    query: Partial<ListPromptsQuery> = {},
    options: ReadOptions = {},
  ): Promise<ListResponse<Prompt>> {
    return request('/api/prompts', {
      method: 'GET',
      query: {
        q: query.q,
        status: query.status,
        tag: query.tag,
        limit: query.limit?.toString(),
      },
      signal: options.signal,
    });
  },
  createPrompt(body: CreatePromptRequest): Promise<PromptDetail> {
    return request('/api/prompts', { method: 'POST', body });
  },
  getPrompt(id: string): Promise<PromptDetail> {
    return request(`/api/prompts/${id}`, { method: 'GET' });
  },
  updatePrompt(id: string, body: UpdatePromptRequest): Promise<Prompt> {
    return request(`/api/prompts/${id}`, { method: 'PATCH', body });
  },
  duplicatePrompt(id: string, body: DuplicatePromptRequest): Promise<PromptDetail> {
    return request(`/api/prompts/${id}/duplicate`, { method: 'POST', body });
  },
  archivePrompt(id: string): Promise<Prompt> {
    return request(`/api/prompts/${id}`, { method: 'DELETE' });
  },

  // Versions
  createVersion(promptId: string, content: string): Promise<PromptVersion> {
    return request(`/api/prompts/${promptId}/versions`, {
      method: 'POST',
      body: { content },
    });
  },
  restoreVersion(promptId: string, versionId: string): Promise<PromptVersion> {
    return request(`/api/prompts/${promptId}/versions/${versionId}/restore`, {
      method: 'POST',
    });
  },
  renderPreview(content: string, values: Record<string, string>): Promise<{ rendered: string }> {
    return request('/api/render-preview', { method: 'POST', body: { content, values } });
  },

  // Generations
  listJobs(
    query: Partial<ListJobsQuery> = {},
    options: ReadOptions = {},
  ): Promise<ListResponse<GenerationJob>> {
    return request('/api/generations', {
      method: 'GET',
      query: {
        status: query.status,
        promptId: query.promptId,
        limit: query.limit?.toString(),
      },
      signal: options.signal,
    });
  },
  createGeneration(body: CreateGenerationRequest): Promise<CreateGenerationResponse> {
    return request('/api/generations', { method: 'POST', body });
  },
  getJob(id: string): Promise<GenerationJob> {
    return request(`/api/generations/${id}`, { method: 'GET' });
  },
  retryJob(id: string, idempotencyKey: string): Promise<CreateGenerationResponse> {
    return request(`/api/generations/${id}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },
  /**
   * Resume a tracking-exhausted job: re-poll the SAME stored provider task id
   * with NO paid provider create. Idempotent/concurrency-safe; returns the
   * (now running) job. Not a paid action, so it takes no idempotency key.
   */
  resumeJob(id: string): Promise<GenerationJob> {
    return request(`/api/generations/${id}/resume`, { method: 'POST' });
  },

  // Health + mock scenario control
  getHealth(): Promise<HealthStatus> {
    return request('/api/health', { method: 'GET' });
  },
  getMockScenario(): Promise<{ scenario: string; mode: string }> {
    return request('/api/debug/mock', { method: 'GET' });
  },
  setMockScenario(scenario: string): Promise<{ scenario: string; mode: string }> {
    return request('/api/debug/mock', { method: 'PUT', body: { scenario } });
  },
};

export type Api = typeof api;
