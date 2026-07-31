import { describe, expect, it } from 'vitest';
import { H3_MODEL } from '@h3/shared';
import { MinimaxProvider } from './minimaxProvider.js';
import type { FetchLike } from './minimaxTransport.js';
import { ProviderError } from './types.js';

interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

/** Builds a fake fetch that returns the given JSON body and status, recording calls. */
function fakeFetch(
  response: { status: number; body: unknown },
  calls: RecordedCall[] = [],
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  };
}

function makeProvider(fetch: FetchLike, baseUrl = 'https://api.minimaxi.com') {
  return new MinimaxProvider({ baseUrl, apiKey: 'test-key', fetch });
}

describe('MinimaxProvider', () => {
  it('is configured when an api key is provided', () => {
    expect(makeProvider(fakeFetch({ status: 200, body: {} })).configured).toBe(true);
  });

  it('POSTs to /v2/video_generation and returns the provider task id + queued status', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task_id: 'task-123' } }, calls),
    );
    const out = await provider.create({
      renderedPrompt: 'a prompt',
      model: H3_MODEL,
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(out).toEqual({ providerTaskId: 'task-123', status: 'queued' });
    expect(calls[0]!.url).toBe('https://api.minimaxi.com/v2/video_generation');
    expect(calls[0]!.init!.method).toBe('POST');
    // Payload uses top-level `ratio` and the multimodal content array.
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body.ratio).toBe('16:9');
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body.content[0]).toEqual({ type: 'text', text: 'a prompt' });
  });

  it('rejects an unsupported model', async () => {
    const provider = makeProvider(fakeFetch({ status: 200, body: { task_id: 'x' } }));
    await expect(
      provider.create({
        renderedPrompt: 'p',
        model: 'video-01',
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps a 401 envelope into an auth ProviderError and never throws raw', async () => {
    const provider = makeProvider(
      fakeFetch({
        status: 401,
        body: { type: 'error', error: { type: 'auth', message: 'unauthorized', http_code: 401 } },
      }),
    );
    await expect(
      provider.create({
        renderedPrompt: 'p',
        model: H3_MODEL,
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
    ).rejects.toMatchObject({ category: 'auth' });
  });

  it('queries the path-segment route and maps nested task.status + task.content.url', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      fakeFetch(
        {
          status: 200,
          body: {
            task: {
              task_id: 't1',
              status: 'succeeded',
              content: { url: 'https://x/v.mp4' },
            },
          },
        },
        calls,
      ),
    );
    const out = await provider.query('t1');
    // task_id is encoded as a path segment, not a query string.
    expect(calls[0]!.url).toBe('https://api.minimaxi.com/v2/query/video_generation/t1');
    expect(calls[0]!.init!.method).toBe('GET');
    expect(out.status).toBe('succeeded');
    expect(out.resultUrl).toBe('https://x/v.mp4');
  });

  it('encodes special characters in the task id path segment', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task: { status: 'running' } } }, calls),
    );
    await provider.query('a b/c%2F');
    expect(calls[0]!.url).toBe(
      'https://api.minimaxi.com/v2/query/video_generation/a%20b%2Fc%252F',
    );
  });

  it('maps a nested failed task + task.error into a failure', async () => {
    const provider = makeProvider(
      fakeFetch({
        status: 200,
        body: { task: { status: 'failed', error: { message: 'flagged' } } },
      }),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('failed');
    expect(out.failure?.message).toBe('flagged');
  });

  it('converts a succeeded query with no usable url into a recoverable failure (no null-url succeeded)', async () => {
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task: { status: 'succeeded' } } }),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('failed'); // recoverable, not a null-resultUrl succeeded
    expect(out.failure?.category).toBe('provider_failure');
    expect(out.resultUrl).toBeUndefined();
  });

  it('classifies an async task.error by its code (not always provider_failure)', async () => {
    const provider = makeProvider(
      fakeFetch({
        status: 200,
        body: {
          task: { status: 'failed', error: { message: 'blocked', code: 'SAFETY' } },
        },
      }),
    );
    const out = await provider.query('t1');
    expect(out.failure?.category).toBe('content_moderation');
  });

  it('maps cancelled to a terminal failed status', async () => {
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task: { status: 'cancelled' } } }),
    );
    expect((await provider.query('t1')).status).toBe('failed');
  });

  it('normalizes a trailing slash on the base url', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task_id: 't1' } }, calls),
      'https://api.minimaxi.com/',
    );
    await provider.create({
      renderedPrompt: 'p',
      model: H3_MODEL,
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(calls[0]!.url).toBe('https://api.minimaxi.com/v2/video_generation');
  });

  it('uses credentials server-side (Authorization Bearer) and never returns them', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task_id: 't1' } }, calls),
    );
    const out = await provider.create({
      renderedPrompt: 'p',
      model: H3_MODEL,
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(calls[0]!.init!.headers!.Authorization).toBe('Bearer test-key');
    expect(JSON.stringify(out)).not.toContain('test-key');
  });
});
