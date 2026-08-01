/**
 * Real MiniMax-Hailuo-2.3 adapter. Implements VideoProvider by building the
 * flat request payload, calling the transport, and mapping provider state/errors
 * into the local job state machine. Credentials stay in the transport.
 *
 * Official endpoints (base URL defaults to https://api.minimax.io):
 *  - POST /v1/video_generation            -> { task_id, base_resp }
 *  - GET  /v1/query/video_generation?task_id=…  -> { task_id, status, file_id, base_resp }
 *  - GET  /v1/files/retrieve?file_id=…    -> { file: { download_url }, base_resp }
 */

import { MINIMAX_MODEL, ProviderErrorCategory } from '@h3/shared';
import {
  baseRespFailure,
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
    if (input.model !== MINIMAX_MODEL) {
      throw new ProviderError(
        ProviderErrorCategory.INVALID_REQUEST,
        `Unsupported model "${input.model}". Only ${MINIMAX_MODEL} is supported.`,
        400,
      );
    }
    const payload = buildCreatePayload(input);
    const body = await this.transport.post('/v1/video_generation', payload);

    // A nonzero base_resp on a 2xx create is a typed provider failure.
    const failure = baseRespFailure(body);
    if (failure) {
      throw new ProviderError(failure.category, failure.message);
    }

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
    // Official query route: task_id is a QUERY PARAMETER (not a path segment).
    const body = await this.transport.get('/v1/query/video_generation', {
      task_id: providerTaskId,
    });
    const mapped = await mapQueryResult(body, (fileId) =>
      this.transport.get('/v1/files/retrieve', { file_id: fileId }),
    );
    return { providerTaskId, ...mapped };
  }
}
