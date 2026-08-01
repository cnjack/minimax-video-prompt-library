import { describe, expect, it } from 'vitest';
import { MINIMAX_MODEL } from '@h3/shared';
import { MinimaxProvider } from './minimaxProvider.js';
import type { FetchLike } from './minimaxTransport.js';
import { ProviderError } from './types.js';

interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

const OK = { status_code: 0, status_msg: 'success' };

/**
 * Fake fetch that routes by URL: `create` returns `createBody`, the video query
 * returns `queryBody`, and `/v1/files/retrieve` returns `retrieveBody`. Records
 * every call so URL/method/body assertions are exact. Non-2xx `httpStatus`
 * simulates a transport-level failure.
 */
function routingFetch(
  createBody: unknown,
  queryBody: unknown,
  retrieveBody: unknown = { file: { download_url: 'https://x/v.mp4' }, base_resp: OK },
  calls: RecordedCall[] = [],
  httpStatus = 200,
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    let body: unknown;
    if (url.includes('/v1/video_generation') && init?.method === 'POST') {
      body = createBody;
    } else if (url.includes('/v1/query/video_generation')) {
      body = queryBody;
    } else if (url.includes('/v1/files/retrieve')) {
      body = retrieveBody;
    } else {
      body = {};
    }
    return {
      ok: httpStatus >= 200 && httpStatus < 300,
      status: httpStatus,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

function makeProvider(fetch: FetchLike, baseUrl = 'https://api.minimax.io') {
  return new MinimaxProvider({ baseUrl, apiKey: 'test-key', fetch });
}

describe('MinimaxProvider (MiniMax-Hailuo-2.3 /v1 contract)', () => {
  it('is configured when an api key is provided', () => {
    expect(makeProvider(routingFetch({}, {})).configured).toBe(true);
  });

  it('POSTs to /v1/video_generation with a flat body and returns task id + queued', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch({ task_id: 'task-123', base_resp: OK }, {}, undefined, calls),
    );
    const out = await provider.create({
      renderedPrompt: 'a prompt',
      model: MINIMAX_MODEL,
      durationSeconds: 6,
      resolution: '1080P',
    });
    expect(out).toEqual({ providerTaskId: 'task-123', status: 'queued' });
    expect(calls[0]!.url).toBe('https://api.minimax.io/v1/video_generation');
    expect(calls[0]!.init!.method).toBe('POST');
    // Flat body — no content array, no ratio.
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body).toEqual({
      model: 'MiniMax-Hailuo-2.3',
      prompt: 'a prompt',
      duration: 6,
      resolution: '1080P',
    });
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('ratio');
  });

  it('adds first_frame_image for image-to-video', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch({ task_id: 't', base_resp: OK }, {}, undefined, calls),
    );
    await provider.create({
      renderedPrompt: 'p',
      model: MINIMAX_MODEL,
      durationSeconds: 6,
      resolution: '768P',
      firstFrameUrl: 'https://e.com/ff.jpeg',
    });
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body.first_frame_image).toBe('https://e.com/ff.jpeg');
  });

  it('rejects an unsupported model (never sends MiniMax-H3)', async () => {
    const provider = makeProvider(routingFetch({ task_id: 'x', base_resp: OK }, {}));
    await expect(
      provider.create({
        renderedPrompt: 'p',
        model: 'MiniMax-H3',
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('treats a nonzero base_resp on create as a typed ProviderError', async () => {
    const provider = makeProvider(
      routingFetch(
        { task_id: 'x', base_resp: { status_code: 1004, status_msg: 'bad key' } },
        {},
      ),
    );
    await expect(
      provider.create({
        renderedPrompt: 'p',
        model: MINIMAX_MODEL,
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toMatchObject({ category: 'auth' });
  });

  it('fails when a 2xx create omits task_id', async () => {
    const provider = makeProvider(routingFetch({ base_resp: OK }, {}));
    await expect(
      provider.create({
        renderedPrompt: 'p',
        model: MINIMAX_MODEL,
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toMatchObject({ category: 'provider_failure' });
  });

  it('maps a 401 HTTP response into an auth ProviderError', async () => {
    const provider = makeProvider(
      routingFetch({}, {}, undefined, [], 401),
    );
    await expect(
      provider.create({
        renderedPrompt: 'p',
        model: MINIMAX_MODEL,
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toMatchObject({ category: 'auth' });
  });

  it('queries with task_id as a query parameter (not a path segment)', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        { status: 'Processing', base_resp: OK },
        undefined,
        calls,
      ),
    );
    await provider.query('t 1'); // includes a space to prove query encoding
    expect(calls[0]!.url).toBe(
      'https://api.minimax.io/v1/query/video_generation?task_id=t+1',
    );
    expect(calls[0]!.init!.method).toBe('GET');
  });

  it('on Success retrieves file_id and surfaces file.download_url', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        {
          task_id: 't1',
          status: 'Success',
          file_id: 'file-9',
          base_resp: OK,
        },
        { file: { download_url: 'https://x/v.mp4' }, base_resp: OK },
        calls,
      ),
    );
    const out = await provider.query('t1');
    // Second call is the retrieve, keyed by file_id as a query parameter.
    expect(calls[1]!.url).toBe(
      'https://api.minimax.io/v1/files/retrieve?file_id=file-9',
    );
    expect(out.status).toBe('succeeded');
    expect(out.resultUrl).toBe('https://x/v.mp4');
  });

  it('maps Processing to running with no retrieve call', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        { status: 'Processing', base_resp: OK },
        undefined,
        calls,
      ),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('running');
    expect(calls).toHaveLength(1); // no file retrieve while still running
  });

  it('maps Fail to a provider_failure', async () => {
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        { status: 'Fail', base_resp: OK },
      ),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe('provider_failure');
  });

  it('maps Preparing and Queueing to queued', async () => {
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        { status: 'Preparing', base_resp: OK },
      ),
    );
    expect((await provider.query('t1')).status).toBe('queued');
  });

  it('treats a nonzero base_resp on query as a typed failure', async () => {
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        {
          status: 'Processing',
          base_resp: { status_code: 1027, status_msg: 'sensitive output' },
        },
      ),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe('content_moderation');
  });

  it('converts Success without a file_id into a recoverable failure', async () => {
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        { status: 'Success', base_resp: OK },
      ),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('failed');
    expect(out.failure?.message).toMatch(/file_id/i);
  });

  it('converts a retrieve base_resp error into a typed failure', async () => {
    const provider = makeProvider(
      routingFetch(
        { task_id: 't1', base_resp: OK },
        { status: 'Success', file_id: 'f1', base_resp: OK },
        { base_resp: { status_code: 1002, status_msg: 'rate limited' } },
      ),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe('rate_limit');
  });

  it('normalizes a trailing slash on the base url', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch({ task_id: 't1', base_resp: OK }, {}, undefined, calls),
      'https://api.minimax.io/',
    );
    await provider.create({
      renderedPrompt: 'p',
      model: MINIMAX_MODEL,
      durationSeconds: 6,
      resolution: '768P',
    });
    expect(calls[0]!.url).toBe('https://api.minimax.io/v1/video_generation');
  });

  it('uses credentials server-side (Authorization Bearer) and never returns them', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      routingFetch({ task_id: 't1', base_resp: OK }, {}, undefined, calls),
    );
    const out = await provider.create({
      renderedPrompt: 'p',
      model: MINIMAX_MODEL,
      durationSeconds: 6,
      resolution: '768P',
    });
    expect(calls[0]!.init!.headers!.Authorization).toBe('Bearer test-key');
    expect(JSON.stringify(out)).not.toContain('test-key');
  });
});
