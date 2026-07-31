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
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const url = options.query
    ? `${path}?${new URLSearchParams(
        Object.entries(options.query).filter(([, v]) => v !== undefined) as [string, string][],
      ).toString()}`
    : path;

  const response = await fetch(url, {
    method: options.method,
    headers:
      options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const errorBody = (parsed as { error?: ApiErrorBody } | undefined)?.error;
    throw new ApiClientError(
      errorBody ?? {
        code: 'internal_error',
        message: `Request failed with status ${response.status}.`,
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? 'unknown',
      },
    );
  }
  return parsed as T;
}

export const api = {
  // Prompts
  listPrompts(query: Partial<ListPromptsQuery> = {}): Promise<ListResponse<Prompt>> {
    return request('/api/prompts', {
      method: 'GET',
      query: {
        q: query.q,
        status: query.status,
        tag: query.tag,
        limit: query.limit?.toString(),
      },
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
  listJobs(query: Partial<ListJobsQuery> = {}): Promise<ListResponse<GenerationJob>> {
    return request('/api/generations', {
      method: 'GET',
      query: {
        status: query.status,
        promptId: query.promptId,
        limit: query.limit?.toString(),
      },
    });
  },
  createGeneration(body: CreateGenerationRequest): Promise<CreateGenerationResponse> {
    return request('/api/generations', { method: 'POST', body });
  },
  getJob(id: string): Promise<GenerationJob> {
    return request(`/api/generations/${id}`, { method: 'GET' });
  },
  retryJob(id: string): Promise<CreateGenerationResponse> {
    return request(`/api/generations/${id}/retry`, { method: 'POST' });
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
