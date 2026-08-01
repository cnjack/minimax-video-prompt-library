/**
 * MiniMax HTTP transport. Uses an injectable fetch so tests can drive it with a
 * fake transport without any network. Authorization is added here, server-side,
 * and is never logged. Rendered media payloads are sent but not logged.
 */

import { ProviderErrorCategory } from '@h3/shared';
import { classifyHttpFailure } from './minimaxMapping.js';
import { ProviderError } from './types.js';

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface MinimaxTransportOptions {
  baseUrl: string;
  apiKey: string;
  groupId?: string | null;
  fetch?: FetchLike;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
  /** Logger that must never receive secrets. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class MinimaxTransport {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;

  constructor(private readonly options: MinimaxTransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    // Normalize a trailing slash so we never produce `//v1/...`. Done in
    // config too; repeated defensively here so the transport is safe in tests.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.log = options.log;
  }

  async post(path: string, payload: unknown): Promise<unknown> {
    return this.request('POST', path, JSON.stringify(payload));
  }

  async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const search = params && Object.keys(params).length > 0
      ? `?${new URLSearchParams(params).toString()}`
      : '';
    return this.request('GET', `${path}${search}`);
  }

  private async request(
    method: string,
    path: string,
    body?: string,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Authorization is attached here and intentionally excluded from logs.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    if (this.options.groupId) {
      headers['GroupId'] = this.options.groupId;
    }
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const responseBody = await safeJson(response);
      if (!response.ok) {
        const { category, message } = classifyHttpFailure({
          status: response.status,
          body: responseBody,
        });
        this.log?.('warn', `MiniMax ${method} ${path} failed: HTTP ${response.status}`);
        throw new ProviderError(category, message, response.status);
      }
      return responseBody;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      const aborted = error instanceof Error && error.name === 'AbortError';
      this.log?.(
        'warn',
        `MiniMax ${method} ${path} transport error${aborted ? ' (timeout)' : ''}`,
      );
      throw new ProviderError(
        ProviderErrorCategory.PROVIDER_FAILURE,
        aborted
          ? 'MiniMax request timed out.'
          : 'Could not reach the MiniMax service.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(response: {
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
