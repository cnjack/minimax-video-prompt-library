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
  promptService = new PromptService(prompts, versions);
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

describe('util: isUniqueConstraintError', () => {
  it('detects a SQLite UNIQUE constraint message', async () => {
    const { isUniqueConstraintError } = await import('../util.js');
    expect(
      isUniqueConstraintError(
        new Error('UNIQUE constraint failed: generation_jobs.idempotency_key'),
      ),
    ).toBe(true);
    expect(isUniqueConstraintError(new Error('no such table'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
