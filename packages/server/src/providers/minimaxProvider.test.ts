import { describe, expect, it } from 'vitest';
import { H3_MODEL } from '@h3/shared';
import { MinimaxProvider } from './minimaxProvider.js';
import type { FetchLike } from './minimaxTransport.js';
import { ProviderError } from './types.js';

/** Builds a fake fetch that returns the given JSON body and status. */
function fakeFetch(response: { status: number; body: unknown }): FetchLike {
  return async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
  });
}

function makeProvider(fetch: FetchLike) {
  return new MinimaxProvider({
    baseUrl: 'https://api.minimaxi.com',
    apiKey: 'test-key',
    fetch,
  });
}

describe('MinimaxProvider', () => {
  it('is configured when an api key is provided', () => {
    expect(makeProvider(fakeFetch({ status: 200, body: {} })).configured).toBe(true);
  });

  it('creates a generation and returns the provider task id + queued status', async () => {
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { task_id: 'task-123' } }),
    );
    const out = await provider.create({
      renderedPrompt: 'a prompt',
      model: H3_MODEL,
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(out).toEqual({ providerTaskId: 'task-123', status: 'queued' });
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

  it('maps a 401 into an auth ProviderError and never throws raw', async () => {
    const provider = makeProvider(
      fakeFetch({
        status: 401,
        body: { base_resp: { status_code: 1004, status_msg: 'unauthorized' } },
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

  it('queries and maps a succeeded status with a result url', async () => {
    const provider = makeProvider(
      fakeFetch({
        status: 200,
        body: { task_id: 't1', status: 'Success', download_url: 'https://x/v.mp4' },
      }),
    );
    const out = await provider.query('t1');
    expect(out.status).toBe('succeeded');
    expect(out.resultUrl).toBe('https://x/v.mp4');
  });

  it('queries a processing task as running', async () => {
    const provider = makeProvider(
      fakeFetch({ status: 200, body: { status: 'Processing' } }),
    );
    expect((await provider.query('t1')).status).toBe('running');
  });

  it('uses credentials server-side and never returns them via the public API', async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchSpy: FetchLike = async (_url, init) => {
      sentHeaders = init?.headers ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ task_id: 't1' }),
        text: async () => '{}',
      };
    };
    const provider = new MinimaxProvider({
      baseUrl: 'https://api.minimaxi.com',
      apiKey: 'test-key',
      fetch: fetchSpy,
    });
    expect(typeof provider.configured).toBe('boolean');
    const out = await provider.create({
      renderedPrompt: 'p',
      model: H3_MODEL,
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    // Authorization is sent to the provider (server-side) ...
    expect(sentHeaders.Authorization).toBe('Bearer test-key');
    // ... but the public output never includes it.
    expect(JSON.stringify(out)).not.toContain('test-key');
    expect(out).toEqual({ providerTaskId: 't1', status: 'queued' });
  });
});
