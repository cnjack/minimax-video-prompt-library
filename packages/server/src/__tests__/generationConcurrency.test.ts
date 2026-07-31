import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './dbHarness.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { PromptRepository } from '../db/repositories/promptRepo.js';
import { VersionRepository } from '../db/repositories/versionRepo.js';
import { MockProvider } from '../providers/mockProvider.js';
import { GenerationService } from '../services/generationService.js';
import { PromptService } from '../services/promptService.js';
import { ErrorCode } from '@h3/shared';
import { computePayloadHash } from '../util.js';
import type { VideoProvider } from '../providers/types.js';
import type {
  CreateJobInput,
  CreateJobOutput,
  QueryJobOutput,
} from '../providers/types.js';
import type { ProviderName, GenerationJob } from '@h3/shared';

let testDb: TestDb;
let promptService: PromptService;
let generationService: GenerationService;
let jobs: JobRepository;

/** A provider wrapper that counts create() calls so we can prove no duplicate. */
function countingProvider(real: MockProvider): VideoProvider & { creates: number } {
  let creates = 0;
  return {
    name: 'mock' as ProviderName,
    configured: true,
    async create(input: CreateJobInput): Promise<CreateJobOutput> {
      creates += 1;
      // Make the submission async-yield so concurrent callers overlap.
      await Promise.resolve();
      return real.create(input);
    },
    async query(id: string): Promise<QueryJobOutput> {
      return real.query(id);
    },
    get creates() {
      return creates;
    },
  };
}

beforeEach(() => {
  testDb = createTestDb();
  const prompts = new PromptRepository(testDb.db);
  const versions = new VersionRepository(testDb.db);
  jobs = new JobRepository(testDb.db);
  promptService = new PromptService(prompts, versions, testDb.db);
});

afterEach(() => {
  testDb.cleanup();
});

function baseRequest(versionId: string, key: string) {
  return {
    promptVersionId: versionId,
    values: { subject: 'cat' },
    durationSeconds: 5,
    aspectRatio: '16:9' as const,
    resolution: '2K' as const,
    idempotencyKey: key,
  };
}

describe('idempotency under concurrency', () => {
  it('concurrent identical submissions create ONE provider call and reuse one job (no duplicate, no 500)', async () => {
    const detail = promptService.create({
      name: 'P',
      description: 'd',
      tags: [],
      content: 'render {{subject}}',
      status: 'active',
    });
    const provider = countingProvider(new MockProvider());
    generationService = new GenerationService(
      new VersionRepository(testDb.db),
      jobs,
      provider,
      'mock',
    );

    const req = baseRequest(detail.versions[0]!.id, 'race-key');
    const results = await Promise.all([
      generationService.create(req),
      generationService.create(req),
      generationService.create(req),
    ]);

    // Exactly one paid provider submission.
    expect(provider.creates).toBe(1);
    // Exactly one job row exists.
    const all = jobs.list({ limit: 100 });
    expect(all).toHaveLength(1);
    const onlyJob = all[0]!;
    // The first response created; the others reused the same job id.
    expect(results.some((r) => !r.reused)).toBe(true);
    expect(results.filter((r) => r.reused).length).toBe(2);
    expect(results.every((r) => r.job.id === onlyJob.id)).toBe(true);
  });

  it('re-resolves a UNIQUE insert race into reuse (same payload) instead of a 500', async () => {
    const detail = promptService.create({
      name: 'P',
      description: 'd',
      tags: [],
      content: 'render {{subject}}',
      status: 'active',
    });

    const racedJob: GenerationJob = {
      id: 'raced-id',
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
      status: 'queued',
      provider: 'mock',
      providerTaskId: null,
      resultUrl: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'race-key',
      // Same payload hash as the request below so the race resolves to reuse.
      idempotencyPayloadHash: computePayloadHash({
        promptVersionId: detail.versions[0]!.id,
        values: { subject: 'cat' },
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
      parameters: {},
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
    };

    // A fake jobs repository that simulates a concurrent winner:
    //  - findByIdempotencyKey returns null the first time (the race window),
    //  - create() throws a SQLite-shaped UNIQUE constraint error,
    //  - findByIdempotencyKey then returns the winner's row on re-resolution.
    let findCalls = 0;
    let createThrown = false;
    const fakeJobs = {
      findByIdempotencyKey: () => {
        findCalls += 1;
        return findCalls === 1 ? null : racedJob;
      },
      create: () => {
        createThrown = true;
        const err = new Error(
          'UNIQUE constraint failed: generation_jobs.idempotency_key',
        );
        throw err;
      },
      updateStatus: () => racedJob,
      getById: () => racedJob,
      list: () => [] as GenerationJob[],
      listByPrompt: () => [] as GenerationJob[],
      listNonTerminal: () => [] as GenerationJob[],
      setParameters: () => {},
      recoverUnsubmitted: () => [] as string[],
    } as unknown as JobRepository;

    const provider = countingProvider(new MockProvider());
    generationService = new GenerationService(
      new VersionRepository(testDb.db),
      fakeJobs,
      provider,
      'mock',
    );

    const result = await generationService.create(
      baseRequest(detail.versions[0]!.id, 'race-key'),
    );

    expect(createThrown).toBe(true);
    expect(findCalls).toBe(2);
    // Reused the winner; did NOT submit again to the provider.
    expect(result.reused).toBe(true);
    expect(result.job.id).toBe('raced-id');
    expect(provider.creates).toBe(0);
  });

  it('re-resolves a UNIQUE insert race into 409 when the payload differs', async () => {
    const detail = promptService.create({
      name: 'P',
      description: 'd',
      tags: [],
      content: 'render {{subject}}',
      status: 'active',
    });

    const racedJob: GenerationJob = {
      id: 'raced-id',
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
      status: 'queued',
      provider: 'mock',
      providerTaskId: null,
      resultUrl: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'race-key',
      idempotencyPayloadHash: 'DIFFERENT-hash',
      parameters: {},
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
    };

    let findCalls = 0;
    const fakeJobs = {
      findByIdempotencyKey: () => {
        findCalls += 1;
        return findCalls === 1 ? null : racedJob;
      },
      create: () => {
        throw new Error(
          'UNIQUE constraint failed: generation_jobs.idempotency_key',
        );
      },
      updateStatus: () => racedJob,
      getById: () => racedJob,
      list: () => [] as GenerationJob[],
      listByPrompt: () => [] as GenerationJob[],
      listNonTerminal: () => [] as GenerationJob[],
      setParameters: () => {},
      recoverUnsubmitted: () => [] as string[],
    } as unknown as JobRepository;

    generationService = new GenerationService(
      new VersionRepository(testDb.db),
      fakeJobs,
      new MockProvider(),
      'mock',
    );

    await expect(
      generationService.create(
        baseRequest(detail.versions[0]!.id, 'race-key'),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
    expect(findCalls).toBe(2);
  });
});

describe('retry idempotency (per-attempt Idempotency-Key token)', () => {
  let versionId: string;
  let promptId: string;
  let provider: VideoProvider & { creates: number };
  let failedJob: GenerationJob;

  beforeEach(() => {
    const detail = promptService.create({
      name: 'P',
      description: 'd',
      tags: [],
      content: 'render {{subject}}',
      status: 'active',
    });
    promptId = detail.prompt.id;
    versionId = detail.versions[0]!.id;
    provider = countingProvider(new MockProvider());
    generationService = new GenerationService(
      new VersionRepository(testDb.db),
      jobs,
      provider,
      'mock',
    );
    // Plant a FAILED source job whose stored scenario is 'success' so that a
    // retry actually submits (queued) instead of failing again. This isolates
    // retry idempotency from the provider submission path.
    failedJob = jobs.create({
      id: 'orig-failed',
      promptId,
      promptVersionId: versionId,
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
      status: 'failed',
      provider: 'mock',
      providerTaskId: null,
      resultUrl: null,
      errorCode: 'provider_failure',
      errorMessage: 'boom',
      idempotencyKey: 'orig-key',
      idempotencyPayloadHash: computePayloadHash({
        promptVersionId: versionId,
        values: { subject: 'cat' },
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
      }),
      parameters: {
        values: { subject: 'cat' },
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
        mockScenario: 'success',
      },
      now: '2024-01-01T00:00:00Z',
    });
  });

  it('the SAME token reuses one retried job (transport retry does not double-charge)', async () => {
    const r1 = await generationService.retry(failedJob.id, 'retry-token-same');
    expect(r1.reused).toBe(false);
    expect(r1.job.status).toBe('queued');
    const retriedId = r1.job.id;

    // A transport retry of the same POST carries the SAME token and reuses the
    // retried job — never a second paid generation.
    const r2 = await generationService.retry(failedJob.id, 'retry-token-same');
    expect(r2.reused).toBe(true);
    expect(r2.job.id).toBe(retriedId);

    // Exactly one paid submission for the retry; zero for the planted source.
    expect(provider.creates).toBe(1);
    // Source + exactly one retried job.
    expect(jobs.list({ limit: 100 })).toHaveLength(2);
  });

  it('a NEW token after a retry creates a DISTINCT job (deliberate retry creates C)', async () => {
    // First deliberate retry of the source with token A.
    const r1 = await generationService.retry(failedJob.id, 'token-A');
    // A later deliberate retry of the SAME source supplies a NEW token (B) and
    // must create a distinct job — the old derived `retry:<id>` key reused the
    // first retried job forever.
    const r2 = await generationService.retry(failedJob.id, 'token-B');
    expect(r1.reused).toBe(false);
    expect(r2.reused).toBe(false);
    expect(r1.job.id).not.toBe(r2.job.id);
    expect(provider.creates).toBe(2);
    // Source + two distinct retried jobs.
    expect(jobs.list({ limit: 100 })).toHaveLength(3);
  });

  it('concurrent retries with the SAME token create exactly ONE retried job (no double charge)', async () => {
    const token = 'retry-token-concurrent';
    const results = await Promise.all([
      generationService.retry(failedJob.id, token),
      generationService.retry(failedJob.id, token),
      generationService.retry(failedJob.id, token),
    ]);
    expect(provider.creates).toBe(1);
    expect(jobs.list({ limit: 100 })).toHaveLength(2);
    const created = results.find((r) => !r.reused);
    expect(created).toBeTruthy();
    expect(results.filter((r) => r.reused)).toHaveLength(2);
    expect(results.every((r) => r.job.id === created!.job.id)).toBe(true);
  });

  it('retrying a DIFFERENT source job creates a distinct job', async () => {
    // A second failed source job.
    const other = jobs.create({
      id: 'orig-failed-2',
      promptId,
      promptVersionId: versionId,
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
      status: 'failed',
      provider: 'mock',
      providerTaskId: null,
      resultUrl: null,
      errorCode: 'provider_failure',
      errorMessage: 'boom',
      idempotencyKey: 'orig-key-2',
      idempotencyPayloadHash: 'h2',
      parameters: {
        values: { subject: 'cat' },
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
        mockScenario: 'success',
      },
      now: '2024-01-01T00:00:00Z',
    });

    const r1 = await generationService.retry(failedJob.id, 'src-1-token');
    const r2 = await generationService.retry(other.id, 'src-2-token');
    expect(r1.job.id).not.toBe(r2.job.id);
    expect(provider.creates).toBe(2);
    // Two sources + two distinct retried jobs.
    expect(jobs.list({ limit: 100 })).toHaveLength(4);
  });
});

describe('util: isUniqueConstraintError', () => {
  it('detects a SQLite UNIQUE constraint message and rejects non-unique constraints', async () => {
    const { isUniqueConstraintError } = await import('../util.js');
    expect(
      isUniqueConstraintError(
        new Error('UNIQUE constraint failed: generation_jobs.idempotency_key'),
      ),
    ).toBe(true);
    // Non-unique constraint violations must NOT be misreported as an idempotency
    // reuse — only UNIQUE (and PRIMARY KEY) conflicts qualify.
    expect(
      isUniqueConstraintError(new Error('NOT NULL constraint failed: prompts.name')),
    ).toBe(false);
    expect(
      isUniqueConstraintError(new Error('CHECK constraint failed: generation_jobs.status')),
    ).toBe(false);
    expect(
      isUniqueConstraintError(new Error('FOREIGN KEY constraint failed: child.parent')),
    ).toBe(false);
    expect(isUniqueConstraintError(new Error('no such table'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });

  it('recognizes the real UNIQUE/PK extended errcode but not NOT NULL/CHECK codes', async () => {
    const { isUniqueConstraintError } = await import('../util.js');
    const unique = new Error('UNIQUE constraint failed: t.idem') as Error & {
      errcode?: number;
    };
    unique.errcode = 2067; // SQLITE_CONSTRAINT_UNIQUE
    expect(isUniqueConstraintError(unique)).toBe(true);

    const notNull = new Error('NOT NULL constraint failed') as Error & {
      errcode?: number;
    };
    notNull.errcode = 1299; // SQLITE_CONSTRAINT_NOTNULL
    expect(isUniqueConstraintError(notNull)).toBe(false);

    const check = new Error('CHECK constraint failed') as Error & {
      errcode?: number;
    };
    check.errcode = 275; // SQLITE_CONSTRAINT_CHECK
    expect(isUniqueConstraintError(check)).toBe(false);

    // The generic primary code 19 must never be treated as a UNIQUE race.
    const generic = new Error('constraint') as Error & { errcode?: number };
    generic.errcode = 19;
    expect(isUniqueConstraintError(generic)).toBe(false);
  });
});
