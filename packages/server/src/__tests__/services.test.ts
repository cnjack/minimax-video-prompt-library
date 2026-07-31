import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { createTestDb, type TestDb } from './dbHarness.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { PromptRepository } from '../db/repositories/promptRepo.js';
import { VersionRepository } from '../db/repositories/versionRepo.js';
import { MockProvider } from '../providers/mockProvider.js';
import { JobPoller } from '../poller/poller.js';
import { GenerationService } from '../services/generationService.js';
import { PromptService } from '../services/promptService.js';
import { ApiError } from '../errors.js';
import { ErrorCode } from '@h3/shared';

let testDb: TestDb;
let promptService: PromptService;
let generationService: GenerationService;
let jobs: JobRepository;
let mock: MockProvider;

const mockConfig: AppConfig = {
  port: 0,
  nodeEnv: 'test',
  dbPath: ':memory:',
  providerMode: 'mock',
  minimaxApiKey: null,
  minimaxBaseUrl: 'https://api.minimaxi.com',
  minimaxGroupId: null,
  pollIntervalMs: 1000,
  pollMaxAttempts: 5,
  clientDist: null,
  seedSamples: false,
  instanceId: 'test',
};

beforeEach(() => {
  testDb = createTestDb();
  const prompts = new PromptRepository(testDb.db);
  const versions = new VersionRepository(testDb.db);
  jobs = new JobRepository(testDb.db);
  promptService = new PromptService(prompts, versions);
  mock = new MockProvider();
  generationService = new GenerationService(versions, jobs, mock, 'mock');
});

afterEach(() => {
  testDb.cleanup();
});

function createPromptWithContent(content: string) {
  return promptService.create({
    name: 'P',
    description: 'd',
    tags: [],
    content,
    status: 'active',
  });
}

describe('PromptService', () => {
  it('creates a prompt with a first version as head', () => {
    const detail = createPromptWithContent('Hello {{name}}');
    expect(detail.versions).toHaveLength(1);
    expect(detail.prompt.currentVersionId).toBe(detail.versions[0]!.id);
    expect(detail.versions[0]!.variables).toEqual(['name']);
  });

  it('creates a new immutable version and updates the head', () => {
    const detail = createPromptWithContent('v1 {{a}}');
    const v2 = promptService.createVersion(detail.prompt.id, 'v2 {{a}} {{b}}');
    expect(v2.versionNumber).toBe(2);
    const after = promptService.getDetail(detail.prompt.id);
    expect(after.prompt.currentVersionId).toBe(v2.id);
  });

  it('restores an old version as a new head with the same content', () => {
    const detail = createPromptWithContent('first content');
    promptService.createVersion(detail.prompt.id, 'second content');
    const old = detail.versions[0]!;
    const restored = promptService.restoreVersion(detail.prompt.id, old.id);
    expect(restored.content).toBe('first content');
    expect(restored.versionNumber).toBe(3);
    expect(promptService.getDetail(detail.prompt.id).prompt.currentVersionId).toBe(restored.id);
  });

  it('blocks new versions on an archived prompt', () => {
    const detail = createPromptWithContent('x');
    promptService.update(detail.prompt.id, { status: 'archived' });
    try {
      promptService.createVersion(detail.prompt.id, 'y');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe(ErrorCode.ARCHIVED);
    }
  });

  it('duplicates a prompt with the current head content', () => {
    const detail = createPromptWithContent('dupe me {{x}}');
    const copy = promptService.duplicate(detail.prompt.id);
    expect(copy.prompt.id).not.toBe(detail.prompt.id);
    expect(copy.versions[0]!.content).toBe('dupe me {{x}}');
  });
});

describe('GenerationService idempotency', () => {
  async function baseRequest(overrides: Record<string, unknown> = {}) {
    const detail = createPromptWithContent('render {{subject}}');
    return {
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 5,
      aspectRatio: '16:9' as const,
      resolution: '2K' as const,
      ...overrides,
    };
  }

  it('reuses a job when the same key and payload are resubmitted', async () => {
    const req = await baseRequest({ idempotencyKey: 'k1' });
    const first = await generationService.create(req);
    expect(first.reused).toBe(false);
    const second = await generationService.create(req);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('conflicts when the same key is reused with a different payload', async () => {
    const req = await baseRequest({ idempotencyKey: 'k2' });
    await generationService.create(req);
    const conflict = { ...req, durationSeconds: 8 };
    await expect(generationService.create(conflict)).rejects.toMatchObject({
      code: ErrorCode.IDEMPOTENCY_CONFLICT,
    });
  });

  it('fails the job with a mapped error on the provider_error scenario', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      mockScenario: 'provider_error',
    });
    expect(result.job.status).toBe('failed');
    expect(result.job.errorCode).toBe('auth');
  });

  it('rejects generation when a variable is unresolved', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    await expect(
      generationService.create({
        promptVersionId: detail.versions[0]!.id,
        values: {},
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.UNRESOLVED_VARIABLE });
  });
});

describe('JobPoller lifecycle', () => {
  it('advances a queued job to succeeded across ticks', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const { job } = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      mockScenario: 'success',
    });

    const poller = new JobPoller(jobs, mock, mockConfig);
    await poller.tick(); // queued -> running
    expect(jobs.getById(job.id)?.status).toBe('running');
    await poller.tick(); // running -> succeeded
    const final = jobs.getById(job.id);
    expect(final?.status).toBe('succeeded');
    expect(final?.resultUrl).toMatch(/\.mp4$/);
    expect(final?.completedAt).not.toBeNull();
  });

  it('marks a job failed on the failure scenario', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const { job } = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      mockScenario: 'failure',
    });
    const poller = new JobPoller(jobs, mock, mockConfig);
    await poller.tick();
    await poller.tick();
    const final = jobs.getById(job.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorCode).toBe('content_moderation');
  });
});
