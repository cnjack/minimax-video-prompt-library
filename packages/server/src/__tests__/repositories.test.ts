import { beforeEach, describe, expect, it } from 'vitest';
import { newId, nowIso } from '../util.js';
import { createTestDb, type TestDb } from './dbHarness.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { PromptRepository } from '../db/repositories/promptRepo.js';
import { VersionRepository } from '../db/repositories/versionRepo.js';

let testDb: TestDb;
let prompts: PromptRepository;
let versions: VersionRepository;
let jobs: JobRepository;

beforeEach(() => {
  testDb = createTestDb();
  prompts = new PromptRepository(testDb.db);
  versions = new VersionRepository(testDb.db);
  jobs = new JobRepository(testDb.db);
});

afterEach(() => {
  testDb.cleanup();
});

import { afterEach } from 'vitest';

function makePrompt(status: 'draft' | 'active' = 'active') {
  return prompts.create({
    id: newId(),
    name: 'P',
    description: 'desc',
    tags: ['cinematic'],
    status,
    now: nowIso(),
  });
}

function baseJob(overrides: Record<string, unknown> = {}) {
  const p = makePrompt();
  const v = versions.create({ id: newId(), promptId: p.id, content: 'x', now: nowIso() });
  return jobs.create({
    id: newId(),
    promptId: p.id,
    promptVersionId: v.id,
    renderedPrompt: 'rendered',
    model: 'MiniMax-Hailuo-2.3',
    durationSeconds: 6,
    aspectRatio: 'native',
    resolution: '768P',
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrl: null,
    referenceVideoUrl: null,
    referenceAudioUrl: null,
    status: 'queued',
    provider: 'mock',
    providerTaskId: null,
    resultUrl: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: newId(),
    idempotencyPayloadHash: 'hash-' + Math.random(),
    parameters: {},
    now: nowIso(),
    ...overrides,
  });
}

describe('PromptRepository', () => {
  it('creates and retrieves a prompt', () => {
    const p = makePrompt();
    expect(prompts.getById(p.id)?.name).toBe('P');
    expect(prompts.exists(p.id)).toBe(true);
  });

  it('searches across name, description, and tags', () => {
    prompts.create({ id: newId(), name: 'Cinematic Reveal', description: 'hero', tags: ['product'], status: 'active', now: nowIso() });
    prompts.create({ id: newId(), name: 'Other', description: 'travel', tags: ['social'], status: 'draft', now: nowIso() });
    expect(prompts.list({ q: 'cinematic', limit: 50 })).toHaveLength(1);
    expect(prompts.list({ tag: 'social', limit: 50 })).toHaveLength(1);
    expect(prompts.list({ status: 'draft', limit: 50 })).toHaveLength(1);
  });

  it('archives by setting status and archived_at', () => {
    const p = makePrompt();
    const archived = prompts.archive(p.id, nowIso());
    expect(archived?.status).toBe('archived');
    expect(archived?.archivedAt).not.toBeNull();
  });
});

describe('VersionRepository', () => {
  it('increments version numbers and detects variables', () => {
    const p = makePrompt();
    const v1 = versions.create({ id: newId(), promptId: p.id, content: 'Hello {{name}}', now: nowIso() });
    const v2 = versions.create({ id: newId(), promptId: p.id, content: 'Bye {{name}}', now: nowIso() });
    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
    expect(v1.variables).toEqual(['name']);
  });

  it('lists versions newest first', () => {
    const p = makePrompt();
    versions.create({ id: newId(), promptId: p.id, content: 'a', now: nowIso() });
    versions.create({ id: newId(), promptId: p.id, content: 'b', now: nowIso() });
    const list = versions.listByPrompt(p.id);
    expect(list.map((v) => v.versionNumber)).toEqual([2, 1]);
  });
});

describe('JobRepository', () => {
  it('creates and retrieves a job', () => {
    const job = baseJob();
    expect(jobs.getById(job.id)?.status).toBe('queued');
  });

  it('reads back historical (legacy-contract) job rows without loss', () => {
    // A job persisted under the obsolete H3/v2 contract (old model, an aspect
    // ratio, 2K resolution, reference media, a pre-Hailuo duration) must remain
    // fully readable after the provider correction — only new submissions change.
    const legacy = jobs.create({
      id: newId(),
      promptId: makePrompt().id,
      promptVersionId: versions.create({ id: newId(), promptId: makePrompt().id, content: 'x', now: nowIso() }).id,
      renderedPrompt: 'legacy rendered',
      model: 'MiniMax-H3',
      durationSeconds: 8,
      aspectRatio: '16:9',
      resolution: '2K',
      firstFrameUrl: 'https://e.com/ff.png',
      lastFrameUrl: 'https://e.com/lf.png',
      referenceImageUrl: 'https://e.com/ri.png',
      referenceVideoUrl: null,
      referenceAudioUrl: null,
      status: 'succeeded',
      provider: 'mock',
      providerTaskId: 'legacy-task',
      resultUrl: 'https://x/legacy.mp4',
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'legacy-key',
      idempotencyPayloadHash: 'legacy-hash',
      parameters: { legacy: true },
      now: nowIso(),
    });
    const read = jobs.getById(legacy.id);
    expect(read?.model).toBe('MiniMax-H3');
    expect(read?.aspectRatio).toBe('16:9');
    expect(read?.resolution).toBe('2K');
    expect(read?.durationSeconds).toBe(8);
    expect(read?.firstFrameUrl).toBe('https://e.com/ff.png');
    expect(read?.lastFrameUrl).toBe('https://e.com/lf.png');
    expect(read?.referenceImageUrl).toBe('https://e.com/ri.png');
    expect(read?.status).toBe('succeeded');
    expect(read?.resultUrl).toBe('https://x/legacy.mp4');
    expect((read?.parameters as { legacy?: boolean }).legacy).toBe(true);
  });

  it('finds jobs by idempotency key', () => {
    const job = baseJob({ idempotencyKey: 'key-1' });
    expect(jobs.findByIdempotencyKey('key-1')?.id).toBe(job.id);
  });

  it('enforces idempotency key uniqueness', () => {
    baseJob({ idempotencyKey: 'dup' });
    expect(() => baseJob({ idempotencyKey: 'dup' })).toThrow();
  });

  it('updates status and sets completed_at on terminal', () => {
    const job = baseJob();
    const updated = jobs.updateStatus(job.id, {
      status: 'succeeded',
      resultUrl: 'https://x/v.mp4',
      now: nowIso(),
    });
    expect(updated.job?.status).toBe('succeeded');
    expect(updated.job?.resultUrl).toBe('https://x/v.mp4');
    expect(updated.job?.completedAt).not.toBeNull();
    expect(updated.lostUpdate).toBe(false);
  });

  it('lists only non-terminal jobs', () => {
    const queued = baseJob();
    const succeeded = baseJob({ status: 'succeeded' });
    const ids = jobs.listNonTerminal().map((j) => j.id);
    expect(ids).toContain(queued.id);
    expect(ids).not.toContain(succeeded.id);
  });

  it('recovers orphaned queued/running jobs with no provider task into failed', () => {
    const orphanQueued = baseJob({ status: 'queued', providerTaskId: null });
    const orphanRunning = baseJob({ status: 'running', providerTaskId: null });
    // A running job WITH a provider task is NOT recovered (still being polled).
    const liveRunning = baseJob({ status: 'running', providerTaskId: 'pt-1' });
    // Terminal jobs are left untouched.
    const succeeded = baseJob({ status: 'succeeded' });

    const recovered = jobs.recoverUnsubmitted(nowIso());
    expect(recovered).toHaveLength(2);
    expect(recovered).toContain(orphanQueued.id);
    expect(recovered).toContain(orphanRunning.id);

    expect(jobs.getById(orphanQueued.id)?.status).toBe('failed');
    expect(jobs.getById(orphanQueued.id)?.errorCode).toBe('provider_failure');
    expect(jobs.getById(orphanQueued.id)?.completedAt).not.toBeNull();
    expect(jobs.getById(orphanRunning.id)?.status).toBe('failed');
    // Live and terminal jobs are untouched.
    expect(jobs.getById(liveRunning.id)?.status).toBe('running');
    expect(jobs.getById(succeeded.id)?.status).toBe('succeeded');

    // Idempotent: a second sweep recovers nothing.
    expect(jobs.recoverUnsubmitted(nowIso())).toHaveLength(0);
  });
});

describe('JobRepository.updateStatus compare-and-set guard', () => {
  it('refuses a non-terminal update on an already-terminal row (lostUpdate, unchanged)', () => {
    const job = baseJob({ providerTaskId: 'pt' }); // queued
    jobs.updateStatus(job.id, {
      status: 'succeeded',
      resultUrl: 'https://x/v.mp4',
      now: nowIso(),
    }); // -> terminal

    // A stale non-terminal update must NOT revive the terminal row.
    const outcome = jobs.updateStatus(job.id, { status: 'running', now: nowIso() });
    expect(outcome.lostUpdate).toBe(true);
    expect(outcome.job?.status).toBe('succeeded');
    expect(outcome.job?.resultUrl).toBe('https://x/v.mp4');
  });

  it('applies a non-terminal update to a non-terminal row', () => {
    const job = baseJob({ providerTaskId: 'pt' }); // queued
    const outcome = jobs.updateStatus(job.id, { status: 'running', now: nowIso() });
    expect(outcome.lostUpdate).toBe(false);
    expect(outcome.job?.status).toBe('running');
  });

  it('still applies a terminal update to an already-terminal row (idempotent terminal)', () => {
    const job = baseJob({ status: 'failed', providerTaskId: 'pt' });
    const outcome = jobs.updateStatus(job.id, {
      status: 'succeeded',
      resultUrl: 'https://x/y.mp4',
      now: nowIso(),
    });
    expect(outcome.lostUpdate).toBe(false);
    expect(outcome.job?.status).toBe('succeeded');
  });
});

describe('JobRepository tracking-exhausted + resumeTracking', () => {
  it('listNonTerminal excludes tracking_exhausted (a stalled job is not polled)', () => {
    const queued = baseJob();
    const stalled = baseJob({ status: 'tracking_exhausted', providerTaskId: 'pt' });
    const ids = jobs.listNonTerminal().map((j) => j.id);
    expect(ids).toContain(queued.id);
    expect(ids).not.toContain(stalled.id);
  });

  it('updateStatus refuses a non-terminal write to a tracking_exhausted row (lostUpdate)', () => {
    // A stale poll must not silently revive a stalled row back to running — only
    // the dedicated resumeTracking path may do that.
    const stalled = baseJob({ status: 'tracking_exhausted', providerTaskId: 'pt' });
    const outcome = jobs.updateStatus(stalled.id, { status: 'running', now: nowIso() });
    expect(outcome.lostUpdate).toBe(true);
    expect(outcome.job?.status).toBe('tracking_exhausted'); // unchanged
  });

  it('resumeTracking revives a tracking_exhausted job (with a task id) to running and clears the stale error', () => {
    const stalled = baseJob({
      status: 'tracking_exhausted',
      providerTaskId: 'pt-x',
      errorCode: 'rate_limit',
      errorMessage: 'paused',
    });
    const { job, resumed } = jobs.resumeTracking(stalled.id, nowIso());
    expect(resumed).toBe(true);
    expect(job?.status).toBe('running');
    expect(job?.errorCode).toBeNull(); // stale tracking error cleared
    expect(job?.errorMessage).toBeNull();
    expect(job?.providerTaskId).toBe('pt-x'); // SAME stored task id
  });

  it('resumeTracking is idempotent: a second resume is a safe no-op (resumed=false)', () => {
    const stalled = baseJob({ status: 'tracking_exhausted', providerTaskId: 'pt' });
    expect(jobs.resumeTracking(stalled.id, nowIso()).resumed).toBe(true);
    const second = jobs.resumeTracking(stalled.id, nowIso());
    expect(second.resumed).toBe(false); // row is now running
    expect(second.job?.status).toBe('running');
  });

  it('resumeTracking never revives a genuine-terminal row', () => {
    const failed = baseJob({ status: 'failed', providerTaskId: 'pt' });
    const succeeded = baseJob({ status: 'succeeded', providerTaskId: 'pt-s', resultUrl: 'https://x/y.mp4' });
    expect(jobs.resumeTracking(failed.id, nowIso()).resumed).toBe(false);
    expect(jobs.resumeTracking(succeeded.id, nowIso()).resumed).toBe(false);
    expect(jobs.getById(failed.id)?.status).toBe('failed');
    expect(jobs.getById(succeeded.id)?.status).toBe('succeeded');
  });

  it('resumeTracking refuses a tracking_exhausted row with no stored provider task id', () => {
    const stalled = baseJob({ status: 'tracking_exhausted', providerTaskId: null });
    const { job, resumed } = jobs.resumeTracking(stalled.id, nowIso());
    expect(resumed).toBe(false);
    expect(job?.status).toBe('tracking_exhausted'); // cannot resume without a task id
  });
});

describe('PromptRepository literal LIKE search', () => {
  it('treats _ and % as literals (snake_case, 100%)', () => {
    prompts.create({ id: newId(), name: 'snake_case', description: '', tags: ['snake_case'], status: 'active', now: nowIso() });
    prompts.create({ id: newId(), name: 'snakeXcase', description: '', tags: [], status: 'active', now: nowIso() });
    prompts.create({ id: newId(), name: '100% off', description: '', tags: ['100percent'], status: 'active', now: nowIso() });
    prompts.create({ id: newId(), name: '1000 off', description: '', tags: [], status: 'active', now: nowIso() });

    expect(prompts.list({ q: 'snake_case', limit: 50 }).map((p) => p.name)).toEqual(['snake_case']);
    expect(prompts.list({ q: '100%', limit: 50 }).map((p) => p.name)).toEqual(['100% off']);
    expect(prompts.list({ tag: 'snake_case', limit: 50 }).map((p) => p.name)).toEqual(['snake_case']);
  });

  it('treats a backslash as a literal with ESCAPE', () => {
    prompts.create({ id: newId(), name: 'path\\to\\file', description: '', tags: [], status: 'active', now: nowIso() });
    expect(prompts.list({ q: 'path\\to', limit: 50 }).map((p) => p.name)).toEqual(['path\\to\\file']);
  });

  it('still does plain substring search', () => {
    prompts.create({ id: newId(), name: 'Cinematic Reveal', description: '', tags: [], status: 'active', now: nowIso() });
    expect(prompts.list({ q: 'cinematic', limit: 50 })).toHaveLength(1);
  });
});
