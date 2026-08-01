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
  minimaxBaseUrl: 'https://api.minimax.io',
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
      durationSeconds: 6,
      resolution: '768P' as const,
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
      durationSeconds: 6,
      resolution: '768P',
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
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.UNRESOLVED_VARIABLE });
  });

  it('rejects a rendered prompt exceeding the 2000-char Hailuo limit before submission', async () => {
    // A variable whose value pushes the rendered prompt past 2000 chars.
    const detail = createPromptWithContent('prefix {{huge}}');
    const oversized = 'x'.repeat(2001);
    await expect(
      generationService.create({
        promptVersionId: detail.versions[0]!.id,
        values: { huge: oversized },
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR, status: 400 });

    // No job row should have been created (enforced before persistence).
    expect(jobs.list({ limit: 100 })).toHaveLength(0);
  });

  it('accepts a rendered prompt exactly at the 2000-char boundary', async () => {
    // Build a template that renders to exactly 2000 chars.
    const filler = 'y'.repeat(1999);
    const detail = createPromptWithContent(`${filler}{{a}}`);
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { a: 'z' },
      durationSeconds: 6,
      resolution: '768P',
    });
    expect(result.job.renderedPrompt).toHaveLength(2000);
  });
});

describe('GenerationService prompt override (camera cues)', () => {
  it('uses the supplied prompt verbatim instead of rendering the version', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      prompt: 'a cat, tracking shot',
      durationSeconds: 6,
      resolution: '768P',
    });
    expect(result.job.renderedPrompt).toBe('a cat, tracking shot');
  });

  it('still enforces the Hailuo char limit on the supplied prompt before submission', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    await expect(
      generationService.create({
        promptVersionId: detail.versions[0]!.id,
        // Resolved values so the version itself validates; the oversized
        // override (not the version) is what must trip the char limit.
        values: { subject: 'cat' },
        prompt: 'x'.repeat(2001),
        durationSeconds: 6,
        resolution: '768P',
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
      durationSeconds: 6,
      resolution: '768P',
    });
    expect(result.job.renderedPrompt).toBe('render cat');
  });

  it('distinguishes jobs by the supplied prompt text for idempotency', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const base = {
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 6,
      resolution: '768P' as const,
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

  it('rejects a non-blank override when the version still has unresolved variables', async () => {
    // Defence in depth: even though a prompt override is supplied, the immutable
    // version is validated with `values` first, so an unresolved variable fails
    // before any job/provider call — the override can never mask a bad version.
    const detail = createPromptWithContent('render {{subject}}');
    await expect(
      generationService.create({
        promptVersionId: detail.versions[0]!.id,
        values: {},
        prompt: 'a cat, tracking shot',
        durationSeconds: 6,
        resolution: '768P',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.UNRESOLVED_VARIABLE });
    // No job row created (validated before persistence).
    expect(jobs.list({ limit: 100 })).toHaveLength(0);
  });

  it('uses the validated override verbatim once the version renders successfully', async () => {
    // The version renders to "render cat" (validated) but the override is the
    // final rendered prompt — proving validation does not swap the override in.
    const detail = createPromptWithContent('render {{subject}}');
    const result = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      prompt: 'a cat, tracking shot',
      durationSeconds: 6,
      resolution: '768P',
    });
    expect(result.job.renderedPrompt).toBe('a cat, tracking shot');
  });
});

describe('GenerationService retry retains camera-cue override', () => {
  it('a retried failed job keeps parameters.prompt as the rendered prompt', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    // Submit with a camera-cue override under a deterministic failure scenario
    // so the job lands in the retryable `failed` state.
    const first = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      prompt: 'a cat, tracking shot',
      durationSeconds: 6,
      resolution: '768P',
      mockScenario: 'provider_error',
    });
    expect(first.job.status).toBe('failed');
    expect(first.job.renderedPrompt).toBe('a cat, tracking shot');
    // The override is persisted in the job parameters for the retry path.
    expect((first.job.parameters as { prompt?: string }).prompt).toBe(
      'a cat, tracking shot',
    );

    // Retry must NOT fall back to rendering the immutable version ("render cat");
    // the camera-cue override is carried through and re-used verbatim.
    const retried = await generationService.retry(first.job.id, 'retry-override-1');
    expect(retried.job.id).not.toBe(first.job.id);
    expect(retried.job.renderedPrompt).toBe('a cat, tracking shot');
    expect(retried.job.renderedPrompt).not.toBe('render cat');
  });
});

describe('JobPoller lifecycle', () => {
  it('advances a queued job to succeeded across ticks', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const { job } = await generationService.create({
      promptVersionId: detail.versions[0]!.id,
      values: { subject: 'cat' },
      durationSeconds: 6,
      resolution: '768P',
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
      durationSeconds: 6,
      resolution: '768P',
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

  it('stays retryable (running) on a transient missing file_id — never a failed/null-url row', async () => {
    const detail = createPromptWithContent('render {{subject}}');
    const created = jobs.create({
      id: 'job-succ-no-url',
      promptId: detail.prompt.id,
      promptVersionId: detail.versions[0]!.id,
      renderedPrompt: 'render cat',
      model: 'MiniMax-Hailuo-2.3',
      durationSeconds: 6,
      aspectRatio: 'native',
      resolution: '768P',
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

    // Real adapter over a fake transport returning Success WITHOUT a
    // file_id (so the result cannot be retrieved).
    const provider = new MinimaxProvider({
      baseUrl: 'https://api.minimax.io',
      apiKey: 'test-key',
      fetch: fakeFetch({
        status: 'Success',
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    });
    const poller = new JobPoller(jobs, provider, mockConfig);
    await poller.tick();

    const after = jobs.getById(created.id);
    // P1: a single transient read-path failure (Success without file_id) must NOT
    // terminal-fail an already-paid job. It stays running and is counted against
    // the poller's bounded budget (never a null-url succeeded, never failed).
    expect(after?.status).toBe('running');
    expect(after?.resultUrl).toBeNull();
    expect(after?.completedAt).toBeNull();
    expect(after?.errorCode).toBeNull();
  });
});

describe('JobPoller: transient read-path failures stay retryable (P1)', () => {
  interface RecordedCall {
    url: string;
    method?: string;
  }
  const OK = { status_code: 0, status_msg: 'success' };

  /**
   * Fake fetch that replays a SEQUENCE of query bodies (and retrieve bodies)
   * across successive polls, so a transient read-path blip can be followed by a
   * normal status. Records every call so a "no paid create" assertion is exact.
   * The poller only ever GETs; create (POST /v1/video_generation) never fires.
   */
  function sequencedFetch(
    queryBodies: unknown[],
    retrieveBodies: unknown[] = [
      { file: { download_url: 'https://x/v.mp4' }, base_resp: OK },
    ],
    calls: RecordedCall[] = [],
  ): FetchLike {
    let qi = 0;
    let ri = 0;
    return async (url, init) => {
      calls.push({ url, method: init?.method });
      let body: unknown;
      if (url.includes('/v1/query/video_generation')) {
        body = queryBodies[Math.min(qi, queryBodies.length - 1)];
        qi += 1;
      } else if (url.includes('/v1/files/retrieve')) {
        body = retrieveBodies[Math.min(ri, retrieveBodies.length - 1)];
        ri += 1;
      } else {
        body = {};
      }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };
  }

  function plantRunningJob(id: string, providerTaskId: string) {
    const detail = createPromptWithContent('render {{subject}}');
    return jobs.create({
      id,
      promptId: detail.prompt.id,
      promptVersionId: detail.versions[0]!.id,
      renderedPrompt: 'render cat',
      model: 'MiniMax-Hailuo-2.3',
      durationSeconds: 6,
      aspectRatio: 'native',
      resolution: '768P',
      firstFrameUrl: null,
      lastFrameUrl: null,
      referenceImageUrl: null,
      referenceVideoUrl: null,
      referenceAudioUrl: null,
      status: 'running',
      provider: 'minimax',
      providerTaskId,
      resultUrl: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: `k-${id}`,
      idempotencyPayloadHash: `h-${id}`,
      parameters: {},
      now: nowIso(),
    });
  }

  function minimax(fetch: FetchLike) {
    return new MinimaxProvider({
      baseUrl: 'https://api.minimax.io',
      apiKey: 'test-key',
      fetch,
    });
  }

  it('a transient rate_limit query base_resp then Processing never terminal-fails', async () => {
    const created = plantRunningJob('job-1002-then-proc', 'task-1002');
    const provider = minimax(
      sequencedFetch([
        {
          status: 'Processing',
          base_resp: { status_code: 1002, status_msg: 'rate limited' },
        },
        { status: 'Processing', base_resp: OK },
      ]),
    );
    const poller = new JobPoller(jobs, provider, mockConfig);
    await poller.tick(); // 1002 -> counted, row retained (NOT failed)
    expect(jobs.getById(created.id)?.status).toBe('running');
    await poller.tick(); // Processing -> running
    expect(jobs.getById(created.id)?.status).toBe('running');
    // Never became a terminal failure from the single transient blip.
    expect(jobs.getById(created.id)?.completedAt).toBeNull();
  });

  it('a transient retrieve rate_limit then a successful download stays retryable then succeeds', async () => {
    const created = plantRunningJob('job-retrieve-1002', 'task-ret-1002');
    const success = { task_id: 't', status: 'Success', file_id: 'f1', base_resp: OK };
    const provider = minimax(
      sequencedFetch(
        [success, success],
        [
          { base_resp: { status_code: 1002, status_msg: 'rate limited' } },
          { file: { download_url: 'https://x/v.mp4' }, base_resp: OK },
        ],
      ),
    );
    const poller = new JobPoller(jobs, provider, mockConfig);
    await poller.tick(); // retrieve 1002 -> counted, row retained
    expect(jobs.getById(created.id)?.status).toBe('running');
    expect(jobs.getById(created.id)?.resultUrl).toBeNull();
    await poller.tick(); // retrieve ok -> succeeded
    const final = jobs.getById(created.id);
    expect(final?.status).toBe('succeeded');
    expect(final?.resultUrl).toBe('https://x/v.mp4');
  });

  it('a Success missing file_id then later present stays retryable then succeeds', async () => {
    const created = plantRunningJob('job-no-fileid', 'task-no-fileid');
    const provider = minimax(
      sequencedFetch([
        { status: 'Success', base_resp: OK }, // no file_id yet (transient)
        { status: 'Success', file_id: 'f1', base_resp: OK }, // file_id now present
      ]),
    );
    const poller = new JobPoller(jobs, provider, mockConfig);
    await poller.tick(); // missing file_id -> counted, row retained
    expect(jobs.getById(created.id)?.status).toBe('running');
    await poller.tick(); // file_id present -> succeeded
    expect(jobs.getById(created.id)?.status).toBe('succeeded');
  });

  it('exhausts the read-path budget into tracking_exhausted, then resumes the SAME task with ZERO create calls', async () => {
    const calls: RecordedCall[] = [];
    const created = plantRunningJob('job-exhaust', 'task-exhaust');
    // Query ALWAYS returns a transient rate_limit: never a genuine provider Fail.
    const provider = minimax(
      sequencedFetch(
        [{ status: 'Processing', base_resp: { status_code: 1002, status_msg: 'rate limited' } }],
        undefined,
        calls,
      ),
    );
    const poller = new JobPoller(jobs, provider, mockConfig); // pollMaxAttempts = 5

    for (let i = 0; i < mockConfig.pollMaxAttempts; i += 1) {
      await poller.tick();
    }
    const exhausted = jobs.getById(created.id);
    expect(exhausted?.status).toBe('tracking_exhausted');
    expect(exhausted?.errorCode).toBe('rate_limit');
    expect(exhausted?.providerTaskId).toBe('task-exhaust'); // unchanged
    expect(exhausted?.completedAt).toBeNull(); // NOT a genuine terminal

    // Resume must re-poll the SAME stored provider task id with NO paid create.
    const svc = new GenerationService(
      new VersionRepository(testDb.db),
      jobs,
      provider,
      'minimax',
    );
    const resumed = svc.resume(created.id);
    expect(resumed.status).toBe('running');
    expect(resumed.providerTaskId).toBe('task-exhaust'); // SAME task, no new one
    expect(resumed.errorCode).toBeNull(); // stale tracking error cleared

    // No paid provider create (POST /v1/video_generation) ever happened — only
    // GET reads. This is the core P1 recovery guarantee.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // The resumed job is pollable again.
    expect(jobs.listNonTerminal().map((j) => j.id)).toContain(created.id);

    // Repeated resume is idempotent: a second resume resolves to the running row
    // (the CAS matches no tracking_exhausted row) without error or paid create.
    const again = svc.resume(created.id);
    expect(again.status).toBe('running');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a genuine provider task Fail stays terminal failed (regeneratable, not resumable)', async () => {
    const created = plantRunningJob('job-genuine-fail', 'task-genuine-fail');
    const provider = minimax(sequencedFetch([{ status: 'Fail', base_resp: OK }]));
    const poller = new JobPoller(jobs, provider, mockConfig);
    await poller.tick();
    const final = jobs.getById(created.id);
    expect(final?.status).toBe('failed'); // genuine terminal
    expect(final?.completedAt).not.toBeNull();
    expect(final?.errorCode).toBe('provider_failure');

    // A genuine terminal failed job is regeneratable (retry-as-new) but NOT
    // resumable: resume is rejected (only tracking_exhausted may resume). resume()
    // is synchronous, so the rejection is asserted directly (not via `rejects`).
    const svc = new GenerationService(
      new VersionRepository(testDb.db),
      jobs,
      provider,
      'minimax',
    );
    let thrown: unknown;
    try {
      svc.resume(created.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe(ErrorCode.UNPROCESSABLE);
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
      durationSeconds: 6,
      resolution: '768P',
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
      model: 'MiniMax-Hailuo-2.3',
      durationSeconds: 6,
      aspectRatio: 'native',
      resolution: '768P',
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
