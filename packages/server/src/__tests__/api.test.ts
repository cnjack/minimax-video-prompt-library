import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AppConfig } from '../config.js';
import { createTestDb, type TestDb } from './dbHarness.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { MockProvider } from '../providers/mockProvider.js';
import { JobPoller } from '../poller/poller.js';
import { createAppServices } from '../services/container.js';
import { createApp } from '../app.js';
import { nowIso } from '../util.js';

let testDb: TestDb;
let app: ReturnType<typeof createApp>;
let mock: MockProvider;
let poller: JobPoller;
let jobs: JobRepository;

const config: AppConfig = {
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
  mock = new MockProvider();
  jobs = new JobRepository(testDb.db);
  const services = createAppServices(testDb.db, mock, 'mock');
  app = createApp({ config, services });
  poller = new JobPoller(jobs, mock, config);
});

afterEach(() => {
  testDb.cleanup();
});

describe('Health', () => {
  it('reports ok with mock mode configured', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', mode: 'mock', providerConfigured: true });
  });

  it('liveness is always 200 ok, independent of provider config', async () => {
    const res = await request(app).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });
});

describe('X-Request-Id safety', () => {
  it('echoes a valid inbound request id', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'abc-123_456.789');
    expect(res.headers['x-request-id']).toBe('abc-123_456.789');
  });

  it('ignores an overlong id and generates a fresh one', async () => {
    const longId = 'a'.repeat(500);
    const res = await request(app).get('/api/health').set('X-Request-Id', longId);
    const echoed = res.headers['x-request-id'] as string;
    expect(echoed.length).toBeLessThan(longId.length);
    // (Control-character / injection rejection is covered in the middleware unit test,
    // since the HTTP client itself forbids setting control bytes in a header.)
  });

  it('generates an id when none is provided', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    // And it is reflected in error envelopes.
    const err = await request(app).get('/api/prompts/missing');
    expect(err.body.error.requestId).toBe(err.headers['x-request-id']);
  });
});

describe('Core generation path', () => {
  it('creates a prompt, version, renders, submits, polls to success, and lists history', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'Hero', description: 'd', tags: ['x'], content: 'A film of {{subject}}', status: 'active' })
      .expect(201);
    const promptId = created.body.prompt.id as string;
    const versionId = created.body.versions[0].id as string;

    // Render preview
    const preview = await request(app)
      .post('/api/render-preview')
      .send({ content: 'A film of {{subject}}', values: { subject: 'a car' } })
      .expect(200);
    expect(preview.body.rendered).toBe('A film of a car');

    // New version
    const v2 = await request(app)
      .post(`/api/prompts/${promptId}/versions`)
      .send({ content: 'A film of {{subject}} at {{place}}' })
      .expect(201);
    expect(v2.body.versionNumber).toBe(2);

    // Submit generation from the head version
    const gen = await request(app)
      .post('/api/generations')
      .send({
        promptVersionId: versionId,
        values: { subject: 'a car' },
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '2K',
        idempotencyKey: 'api-key-1',
      })
      .expect(201);
    const jobId = gen.body.job.id as string;
    expect(gen.body.job.status).toBe('queued');
    expect(gen.body.job.renderedPrompt).toBe('A film of a car');

    // Drive the server-side poller to terminal.
    await poller.tick();
    expect((await request(app).get(`/api/generations/${jobId}`).expect(200)).body.status).toBe(
      'running',
    );
    await poller.tick();
    const final = (await request(app).get(`/api/generations/${jobId}`).expect(200)).body;
    expect(final.status).toBe('succeeded');
    expect(final.resultUrl).toMatch(/\.mp4$/);

    // History lists the job
    const history = await request(app).get('/api/generations').expect(200);
    expect(history.body.items.some((j: { id: string }) => j.id === jobId)).toBe(true);

    // Idempotent resubmission reuses the job
    const reuse = await request(app)
      .post('/api/generations')
      .send({
        promptVersionId: versionId,
        values: { subject: 'a car' },
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '2K',
        idempotencyKey: 'api-key-1',
      })
      .expect(200);
    expect(reuse.body.reused).toBe(true);
    expect(reuse.body.job.id).toBe(jobId);
  });

  it('rejects an invalid duration and an invalid url with a validation error', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    const versionId = created.body.versions[0].id as string;

    const badDuration = await request(app)
      .post('/api/generations')
      .send({ promptVersionId: versionId, values: {}, durationSeconds: 3, aspectRatio: '16:9', resolution: '2K' });
    expect(badDuration.status).toBe(400);
    expect(badDuration.body.error.code).toBe('validation_error');

    const badUrl = await request(app)
      .post('/api/generations')
      .send({ promptVersionId: versionId, values: {}, durationSeconds: 4, aspectRatio: '16:9', resolution: '2K', firstFrameUrl: 'ftp://x/y.png' });
    expect(badUrl.status).toBe(400);
  });

  it('returns idempotency conflict on same key, different payload', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x {{a}}' })
      .expect(201);
    const versionId = created.body.versions[0].id as string;

    const base = {
      promptVersionId: versionId,
      values: { a: '1' },
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      idempotencyKey: 'conflict-key',
    };
    await request(app).post('/api/generations').send(base).expect(201);
    const conflict = await request(app)
      .post('/api/generations')
      .send({ ...base, durationSeconds: 10 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });

  it('returns a request id header and envelope on errors', async () => {
    const res = await request(app).get('/api/prompts/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('archives a prompt via DELETE and blocks new versions', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    const promptId = created.body.prompt.id;
    const archived = await request(app).delete(`/api/prompts/${promptId}`).expect(200);
    expect(archived.body.status).toBe('archived');

    const versionAttempt = await request(app)
      .post(`/api/prompts/${promptId}/versions`)
      .send({ content: 'new' });
    expect(versionAttempt.status).toBe(409);
    expect(versionAttempt.body.error.code).toBe('archived');
  });

  it('exposes mock scenario control only in mock mode', async () => {
    const get = await request(app).get('/api/debug/mock').expect(200);
    expect(get.body.scenario).toBe('success');
    await request(app).put('/api/debug/mock').send({ scenario: 'failure' }).expect(200);
    expect(mock.getDefaultScenario()).toBe('failure');
  });
});

describe('aspect ratio / frame mode API rejection', () => {
  it('rejects first-frame mode with a concrete ratio (requires adaptive)', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    const versionId = created.body.versions[0].id as string;

    const bad = await request(app)
      .post('/api/generations')
      .send({
        promptVersionId: versionId,
        values: {},
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '2K',
        firstFrameUrl: 'https://example.com/a.png',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('accepts first-frame mode with adaptive', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    const versionId = created.body.versions[0].id as string;

    await request(app)
      .post('/api/generations')
      .send({
        promptVersionId: versionId,
        values: {},
        durationSeconds: 5,
        aspectRatio: 'adaptive',
        resolution: '2K',
        firstFrameUrl: 'https://example.com/a.png',
      })
      .expect(201);
  });
});

describe('retry idempotency (per-attempt Idempotency-Key header)', () => {
  function plantFailedJob(promptId: string, versionId: string, id: string, params: Record<string, unknown>) {
    return jobs.create({
      id,
      promptId,
      promptVersionId: versionId,
      renderedPrompt: 'x',
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
      idempotencyKey: `src-${id}`,
      idempotencyPayloadHash: `h-${id}`,
      parameters: params,
      now: nowIso(),
    });
  }

  it('same token reuses; a new token creates a distinct job', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    const promptId = created.body.prompt.id as string;
    const versionId = created.body.versions[0].id as string;
    const failed = plantFailedJob(promptId, versionId, 'src-failed', {
      values: {},
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '2K',
      mockScenario: 'success',
    });

    // First retry with token T1 creates a new queued job (201).
    const r1 = await request(app)
      .post(`/api/generations/${failed.id}/retry`)
      .set('Idempotency-Key', 'T1')
      .expect(201);
    expect(r1.body.job.status).toBe('queued');
    const retriedId = r1.body.job.id as string;

    // A transport retry carrying the SAME token reuses the retried job (200).
    const r2 = await request(app)
      .post(`/api/generations/${failed.id}/retry`)
      .set('Idempotency-Key', 'T1')
      .expect(200);
    expect(r2.body.reused).toBe(true);
    expect(r2.body.job.id).toBe(retriedId);

    // A deliberate retry with a NEW token creates a distinct job (201).
    const r3 = await request(app)
      .post(`/api/generations/${failed.id}/retry`)
      .set('Idempotency-Key', 'T2')
      .expect(201);
    expect(r3.body.reused).toBe(false);
    expect(r3.body.job.id).not.toBe(retriedId);

    // Exactly three jobs: source + two distinct retries.
    const history = await request(app).get('/api/generations').expect(200);
    expect(history.body.total).toBe(3);
  });

  it('rejects an invalid Idempotency-Key header with 400 and creates nothing', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    const failed = plantFailedJob(
      created.body.prompt.id,
      created.body.versions[0].id,
      'src-failed-bad',
      { values: {}, durationSeconds: 5, aspectRatio: '16:9', resolution: '2K', mockScenario: 'success' },
    );
    // A header containing a space is not a valid bounded token.
    const bad = await request(app)
      .post(`/api/generations/${failed.id}/retry`)
      .set('Idempotency-Key', 'bad key');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_request');
    expect(jobs.list({ limit: 100 })).toHaveLength(1);
  });

  it('returns 422 UNPROCESSABLE when the stored params are corrupt (no provider request)', async () => {
    const created = await request(app)
      .post('/api/prompts')
      .send({ name: 'P', content: 'x' })
      .expect(201);
    // Corrupt persisted params: an unsupported aspect ratio and missing duration.
    const failed = plantFailedJob(
      created.body.prompt.id,
      created.body.versions[0].id,
      'src-failed-corrupt',
      { values: {}, aspectRatio: 'bogus', resolution: '2K' },
    );

    const res = await request(app)
      .post(`/api/generations/${failed.id}/retry`)
      .set('Idempotency-Key', 'T-corrupt');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unprocessable');
    // No new job was created (only the corrupt source remains).
    expect(jobs.list({ limit: 100 })).toHaveLength(1);
  });
});
