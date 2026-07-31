import { describe, expect, it } from 'vitest';
import { MockProvider } from './mockProvider.js';
import type { CreateJobInput } from './types.js';

function input(scenario?: CreateJobInput['mockScenario']): CreateJobInput {
  return {
    renderedPrompt: 'deterministic prompt',
    model: 'MiniMax-H3',
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '2K',
    mockScenario: scenario,
  };
}

describe('MockProvider', () => {
  it('starts queued then runs then succeeds deterministically', async () => {
    const mock = new MockProvider();
    const created = await mock.create(input('success'));
    expect(created.status).toBe('queued');

    const first = await mock.query(created.providerTaskId);
    expect(first.status).toBe('running');

    const second = await mock.query(created.providerTaskId);
    expect(second.status).toBe('succeeded');
    expect(second.resultUrl).toMatch(/^https:\/\/mock\.minimax\.local\/video\/.+\.mp4$/);
  });

  it('produces a stable result url for the same prompt', async () => {
    const a = new MockProvider();
    const b = new MockProvider();
    const aId = (await a.create(input('success'))).providerTaskId;
    const bId = (await b.create(input('success'))).providerTaskId;
    await a.query(aId);
    await b.query(bId);
    const aResult = (await a.query(aId)).resultUrl;
    const bResult = (await b.query(bId)).resultUrl;
    expect(aResult).toBe(bResult);
  });

  it('fails via content moderation on the failure scenario', async () => {
    const mock = new MockProvider();
    const created = await mock.create(input('failure'));
    await mock.query(created.providerTaskId); // running
    const done = await mock.query(created.providerTaskId);
    expect(done.status).toBe('failed');
    expect(done.failure?.category).toBe('content_moderation');
  });

  it('expires on the expired scenario', async () => {
    const mock = new MockProvider();
    const created = await mock.create(input('expired'));
    await mock.query(created.providerTaskId);
    const done = await mock.query(created.providerTaskId);
    expect(done.status).toBe('expired');
  });

  it('throws at create time for the provider_error scenario', async () => {
    const mock = new MockProvider();
    await expect(mock.create(input('provider_error'))).rejects.toMatchObject({
      category: 'auth',
    });
  });

  it('takes more polls to complete on the slow scenario', async () => {
    const mock = new MockProvider();
    const created = await mock.create(input('slow'));
    await mock.query(created.providerTaskId); // running
    await mock.query(created.providerTaskId); // running
    await mock.query(created.providerTaskId); // running
    const done = await mock.query(created.providerTaskId); // done
    expect(done.status).toBe('succeeded');
  });

  it('resolves an unknown task id terminally (post-restart safety)', async () => {
    const mock = new MockProvider();
    const out = await mock.query('never-seen');
    expect(out.status).toBe('failed');
  });

  it('default scenario can be changed globally', async () => {
    const mock = new MockProvider();
    mock.setDefaultScenario('failure');
    const created = await mock.create(input());
    await mock.query(created.providerTaskId);
    expect((await mock.query(created.providerTaskId)).status).toBe('failed');
  });
});
