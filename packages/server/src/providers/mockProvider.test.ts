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

  it('assigns distinct collision-resistant prefixes per instance', async () => {
    const a = new MockProvider();
    const b = new MockProvider();
    const aId = (await a.create(input('success'))).providerTaskId;
    const bId = (await b.create(input('success'))).providerTaskId;
    expect(aId).not.toBe(bId);
  });

  it('cannot collide with persisted task ids from a previous instance (restart-safe)', async () => {
    // "Previous process" instance + a task left non-terminal (running).
    const oldProvider = new MockProvider();
    const oldCreated = await oldProvider.create(input('success'));
    const oldTaskId = oldCreated.providerTaskId;
    await oldProvider.query(oldTaskId); // -> running

    // Restart: a brand-new instance gets a fresh collision-resistant prefix.
    const newProvider = new MockProvider();
    const newCreated = await newProvider.create(input('success'));
    // The new task id must NOT collide with the old persisted one (no
    // `mock-task-1` reuse that would map two jobs to one in-memory task).
    expect(newCreated.providerTaskId).not.toBe(oldTaskId);

    // The old persisted (non-terminal) task id is unknown to the new instance:
    // it must resolve terminally (failed), NOT return the new task's result.
    const stale = await newProvider.query(oldTaskId);
    expect(stale.status).toBe('failed');
    expect(stale.resultUrl).toBeUndefined();

    // The new task still progresses deterministically.
    expect((await newProvider.query(newCreated.providerTaskId)).status).toBe('running');
    const done = await newProvider.query(newCreated.providerTaskId);
    expect(done.status).toBe('succeeded');
  });
});
