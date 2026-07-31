/**
 * Real MiniMax H3 V2 adapter. Implements VideoProvider by building the
 * multimodal payload, calling the transport, and mapping provider state/errors
 * into the local job state machine. Credentials stay in the transport.
 */

import { H3_MODEL, ProviderErrorCategory } from '@h3/shared';
import {
  extractTaskId,
  mapQueryResult,
} from './minimaxMapping.js';
import { buildCreatePayload } from './minimaxPayload.js';
import { MinimaxTransport } from './minimaxTransport.js';
import type { FetchLike } from './minimaxTransport.js';
import { ProviderError } from './types.js';
import type {
  CreateJobInput,
  CreateJobOutput,
  QueryJobOutput,
  VideoProvider,
} from './types.js';

export interface MinimaxProviderOptions {
  baseUrl: string;
  apiKey: string;
  groupId?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class MinimaxProvider implements VideoProvider {
  readonly name = 'minimax' as const;
  readonly configured: boolean;

  private readonly transport: MinimaxTransport;

  constructor(options: MinimaxProviderOptions) {
    this.configured = Boolean(options.apiKey);
    this.transport = new MinimaxTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      groupId: options.groupId,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      log: options.log,
    });
  }

  async create(input: CreateJobInput): Promise<CreateJobOutput> {
    if (input.model !== H3_MODEL) {
      throw new ProviderError(
        ProviderErrorCategory.INVALID_REQUEST,
        `Unsupported model "${input.model}". Only ${H3_MODEL} is supported.`,
        400,
      );
    }
    const payload = buildCreatePayload(input);
    const body = await this.transport.post('/v2/video_generation', payload);
    const providerTaskId = extractTaskId(body);
    if (!providerTaskId) {
      throw new ProviderError(
        ProviderErrorCategory.PROVIDER_FAILURE,
        'MiniMax accepted the request but returned no task id.',
      );
    }
    return { providerTaskId, status: 'queued' };
  }

  async query(providerTaskId: string): Promise<QueryJobOutput> {
    // Official H3 V2 query path: encode the task id as a path segment.
    const body = await this.transport.get(
      `/v2/query/video_generation/${encodeURIComponent(providerTaskId)}`,
    );
    const mapped = mapQueryResult(body);
    return { providerTaskId, ...mapped };
  }
}
