import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError } from '../api/client.js';

function mockFetch(response: Response | { status: number; body: unknown }) {
  const impl =
    response instanceof Response
      ? async () => response
      : async () =>
          new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  mockFetch({ status: 200, body: { items: [], total: 0 } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('parses a successful list response', async () => {
    const res = await api.listPrompts();
    expect(res).toEqual({ items: [], total: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/^\/api\/prompts/);
    expect(init.method).toBe('GET');
  });

  it('sends a JSON body for POST', async () => {
    await api.createPrompt({ name: 'x', content: 'c', description: '', tags: [], status: 'draft' });
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string).name).toBe('x');
  });

  it('throws ApiClientError with code and request id on a failure envelope', async () => {
    mockFetch({
      status: 404,
      body: {
        error: {
          code: 'not_found',
          message: 'nope',
          status: 404,
          requestId: 'rid-123',
        },
      },
    });
    await expect(api.getPrompt('x')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      requestId: 'rid-123',
      message: 'nope',
    });
    try {
      await api.getJob('x');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiClientError);
    }
  });

  it('builds query strings for filters', async () => {
    await api.listJobs({ status: 'failed', limit: 5 });
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('status=failed');
    expect(url).toContain('limit=5');
  });
});
