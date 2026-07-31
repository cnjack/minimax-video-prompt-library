import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { createTestDb, type TestDb } from './dbHarness.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { PromptRepository } from '../db/repositories/promptRepo.js';
import { VersionRepository } from '../db/repositories/versionRepo.js';
import { MockProvider } from '../providers/mockProvider.js';
import { MinimaxProvider } from '../providers/minimaxProvider.js';
import type { FetchLike } from '../providers/minimaxTransport.js';
import type { VideoProvider } from '../providers/types.js';
import { JobPoller } from '../poller/poller.js';
import { GenerationService } from '../services/generationService.js';
import { PromptService } from '../services/promptService.js';
import { ApiError } from '../errors.js';
import { nowIso } from '../util.js';
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
  promptService = new PromptService(prompts, versions, testDb.db);
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

describe('PromptService.createVersion atomicity', () => {
  // createVersion inserts an immutable version and moves the head pointer in a
  // single SQLite transaction. If the head-pointer update fails, the version
  // insert must roll back (no orphaned version) and the previous head must stay
  // current. Fresh repos on the shared test DB let us spy on setCurrentVersion
  // without touching the module-level promptService.
  function freshService() {
    const prompts = new PromptRepository(testDb.db);
    const versions = new VersionRepository(testDb.db);
    const service = new PromptService(prompts, versions, testDb.db);
    return { prompts, versions, service };
  }

  it('rolls back the version insert when setCurrentVersion fails (no orphan, head unchanged)', () => {
    const { prompts, versions, service } = freshService();
    const detail = service.create({
      name: 'P',
      description: 'd',
      tags: [],
      content: 'v1',
      status: 'active',
    });
    const v2 = service.createVersion(detail.prompt.id, 'v2');
    const headBefore = service.getDetail(detail.prompt.id).prompt.currentVersionId;
    expect(headBefore).toBe(v2.id);
    const countBefore = versions.listByPrompt(detail.prompt.id).length;
    expect(countBefore).toBe(2);

    // Force the head-pointer update to fail mid-operation.
    const boom = new Error('setCurrentVersion boom');
    const spy = vi
      .spyOn(prompts, 'setCurrentVersion')
      .mockImplementation(() => {
        throw boom;
      });

    // createVersion must throw the ORIGINAL error (not a rollback-masked one).
    expect(() => service.createVersion(detail.prompt.id, 'v3')).toThrow(boom);
    spy.mockRestore();

    // The rolled-back version insert left no orphan row ...
    expect(versions.listByPrompt(detail.prompt.id)).toHaveLength(countBefore);
    // ... and the previous head is still current.
    expect(service.getDetail(detail.prompt.id).prompt.currentVersionId).toBe(headBefore);
  });

  it('restoreVersion inherits the atomicity (restore-as-new-head rolls back on failure)', () => {
    const { prompts, versions, service } = freshService();
    const detail = service.create({
      name: 'P',
      description: 'd',
      tags: [],
      content: 'first',
      status: 'active',
    });
    const v1 = detail.versions[0]!;
    service.createVersion(detail.prompt.id, 'second');
    const headBefore = service.getDetail(detail.prompt.id).prompt.currentVersionId;
    const countBefore = versions.listByPrompt(detail.prompt.id).length;
    expect(countBefore).toBe(2);

    // restoreVersion routes through createVersion, so the same atomicity applies.
    const boom = new Error('setCurrentVersion boom');
    const spy = vi
      .spyOn(prompts, 'setCurrentVersion')
      .mockImplementation(() => {
        throw boom;
      });
    expect(() => service.restoreVersion(detail.prompt.id, v1.id)).toThrow(boom);
    spy.mockRestore();

    expect(versions.listByPrompt(detail.prompt.id)).toHaveLength(countBefore);
    expect(service.getDetail(detail.prompt.id).prompt.currentVersionId).toBe(headBefore);
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

  it('rejects a rendered prompt exceeding the 7000-char H3 limit before submission', async () => {
    // A variable whose value pushes the rendered prompt past 7000 chars.
    const detail = createPromptWithContent('prefix {{huge}}');
    const oversized = 'x'.repeat(7000);
    await expect(
      generationService.create({
        promptVersionId: detail.versions[0]!.id,
        values: { huge: oversized },
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR, status: 400 });

    // No job row should have been created (enforced before persistence).
    expect(jobs.list({ limit: 100 })).toHaveLength(0);
  });

  it('accepts a rendered prompt exactly at the 7000-char boundary', async () => {
    // Build a template that renders to exactly 7000 chars.
    const filler = 'y'.repeat(6999);
    const detail = createPromptWithContent(`${filler}{{a}}`);
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { a: 'z' },
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(result.job.renderedPrompt).toHaveLength(7000);
  });
});

describe('GenerationService prompt override (camera cues)', () => {
  it('uses the supplied prompt verbatim instead of rendering the version', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      prompt: 'a cat, tracking shot',
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(result.job.renderedPrompt).toBe('a cat, tracking shot');
  });

  it('still enforces the H3 char limit on the supplied prompt before submission', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    await expect(
      generationService.create({
        promptVersionId: detail.versions[0]!.id,
        values: {},
        prompt: 'x'.repeat(7001),
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR, status: 400 });
    // No job row created (enforced before persistence).
    expect(jobs.list({ limit: 100 })).toHaveLength(0);
  });

  it('treats a blank prompt override as absent and renders from the version', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      prompt: '   ',
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(result.job.renderedPrompt).toBe('render cat');
  });

  it('distinguishes jobs by the supplied prompt text for idempotency', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const base = {
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 5,
      aspectRatio: '16:9' as const,
      resolution: '2K' as const,
      idempotencyKey: 'k-prompt',
    };
    const first = await generationService.create({ ...base, prompt: 'pan left' });
    expect(first.job.renderedPrompt).toBe('pan left');

    // Same key, different prompt text -> conflict (not reuse).
    await expect(
      generationService.create({ ...base, prompt: 'push in' }),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });

    // Same key, same prompt text -> reuse.
    const reused = await generationService.create({ ...base, prompt: 'pan left' });
    expect(reused.reused).toBe(true);
    expect(reused.job.id).toBe(first.job.id);
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

describe('JobPoller: provider "succeeded" without a usable url', () => {
  function fakeFetch(body: unknown): FetchLike {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  it('converts to a recoverable failed job (never an unretryable null-url succeeded)', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const created = jobs.create({
      id: 'job-succ-no-url',
      promptId: detail.prompt.id,
      promptVersionId: detail.versions[0]!.id,
      renderedPrompt: 'render cat',
      model: 'MiniMax-H3',
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      firstFrameUrl: null,
      lastFrameUrl: null,
      referenceImageUrl: null,
      referenceVideoUrl: null,
      referenceAudioUrl: null,
      status: 'running',
      provider: 'mock',
      providerTaskId: 'task-succ-no-url',
      resultUrl: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'k-succ-no-url',
      idempotencyPayloadHash: 'h-succ-no-url',
      parameters: {},
      now: nowIso(),
    });

    // Real adapter over a fake transport returning succeeded WITHOUT a url.
    const provider = new MinimaxProvider({
      baseUrl: 'https://api.minimaxi.com',
      apiKey: 'test-key',
      fetch: fakeFetch({ task: { status: 'succeeded' } }),
    });
    const poller = new JobPoller(jobs, provider, mockConfig);
    await poller.tick();

    const final = jobs.getById(created.id);
    // Not a null-resultUrl succeeded row; a recoverable failed one.
    expect(final?.status).toBe('failed');
    expect(final?.resultUrl).toBeNull();
    expect(final?.errorCode).toBe('provider_failure');
    expect(final?.errorMessage).toMatch(/no usable result URL/i);
    expect(final?.completedAt).not.toBeNull();
  });
});

describe('GenerationService error vocabulary', () => {
  it('a non-ProviderError synchronous failure stores provider_failure (not provider_error)', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const throwingProvider = {
      name: 'mock',
      configured: true,
      async create() {
        throw new Error('unexpected boom');
      },
      async query() {
        return { providerTaskId: 'x', status: 'running' as const };
      },
    } as unknown as VideoProvider;
    const svc = new GenerationService(
      new VersionRepository(testDb.db),
      jobs,
      throwingProvider,
      'mock',
    );
    const result = await svc.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(result.job.status).toBe('failed');
    // Single vocabulary: the persisted error_code is the ProviderErrorCategory
    // `provider_failure`, never the HTTP-envelope code `provider_error`.
    expect(result.job.errorCode).toBe('provider_failure');
  });
});

describe('JobPoller compare-and-set interleaving', () => {
  it('a stale non-terminal poll result does not revive a terminal job', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const created = jobs.create({
      id: 'job-interleave',
      promptId: detail.prompt.id,
      promptVersionId: detail.versions[0]!.id,
      renderedPrompt: 'render cat',
      model: 'MiniMax-H3',
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      firstFrameUrl: null,
      lastFrameUrl: null,
      referenceImageUrl: null,
      referenceVideoUrl: null,
      referenceAudioUrl: null,
      status: 'running',
      provider: 'mock',
      providerTaskId: 'task-interleave',
      resultUrl: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'k-interleave',
      idempotencyPayloadHash: 'h-interleave',
      parameters: {},
      now: nowIso(),
    });

    // A provider that, during the query round-trip, terminalizes the job (a
    // concurrent writer), then returns a STALE non-terminal ('running') result.
    const interleavingProvider = {
      name: 'mock',
      configured: true,
      async create() {
        return { providerTaskId: 'x', status: 'queued' as const };
      },
      async query() {
        jobs.updateStatus(created.id, {
          status: 'succeeded',
          resultUrl: 'https://x/v.mp4',
          now: nowIso(),
        });
        return { providerTaskId: created.providerTaskId!, status: 'running' as const };
      },
    } as unknown as VideoProvider;

    const poller = new JobPoller(jobs, interleavingProvider, mockConfig);
    await poller.tick();

    // The stale 'running' result must not revive the now-succeeded job.
    expect(jobs.getById(created.id)?.status).toBe('succeeded');
  });
});
