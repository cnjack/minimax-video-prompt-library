import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AppConfig } from '../config.js';
import { createTestDb, type TestDb } from './dbHarness.js';
import { JobRepository } from '../db/repositories/jobRepo.js';
import { MockProvider } from '../providers/mockProvider.js';
import { JobPoller } from '../poller/poller.js';
import { createAppServices } from '../services/container.js';
import { createApp } from '../app.js';

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
