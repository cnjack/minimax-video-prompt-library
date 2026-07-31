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
  function baseJob(overrides: Record<string, unknown> = {}) {
    const p = makePrompt();
    const v = versions.create({ id: newId(), promptId: p.id, content: 'x', now: nowIso() });
    return jobs.create({
      id: newId(),
      promptId: p.id,
      promptVersionId: v.id,
      renderedPrompt: 'rendered',
      model: 'MiniMax-H3',
      durationSeconds: 6,
      aspectRatio: '16:9',
      resolution: '2K',
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

  it('creates and retrieves a job', () => {
    const job = baseJob();
    expect(jobs.getById(job.id)?.status).toBe('queued');
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
    expect(updated?.status).toBe('succeeded');
    expect(updated?.resultUrl).toBe('https://x/v.mp4');
    expect(updated?.completedAt).not.toBeNull();
  });

  it('lists only non-terminal jobs', () => {
    const queued = baseJob();
    const succeeded = baseJob({ status: 'succeeded' });
    const ids = jobs.listNonTerminal().map((j) => j.id);
    expect(ids).toContain(queued.id);
    expect(ids).not.toContain(succeeded.id);
  });
});
