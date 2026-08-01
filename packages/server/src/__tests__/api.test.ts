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
        resolution: '768P',
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
        resolution: '768P',
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
      .send({ promptVersionId: versionId, values: {}, durationSeconds: 3, resolution: '768P' });
    expect(badDuration.status).toBe(400);
    expect(badDuration.body.error.code).toBe('validation_error');

    const badUrl = await request(app)
      .post('/api/generations')
      .send({ promptVersionId: versionId, values: {}, durationSeconds: 6, resolution: '768P', firstFrameUrl: 'ftp://x/y.png' });
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
      durationSeconds: 6,
      resolution: '768P',
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

describe('Hailuo-2.3 API contract enforcement', () => {
  it('rejects an unsupported aspect ratio (no ratio parameter)', async () => {
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
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '768P',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('rejects 10s at 1080P (10s only at 768P)', async () => {
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
        durationSeconds: 10,
        resolution: '1080P',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('rejects unsupported reference media', async () => {
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
        durationSeconds: 6,
        resolution: '768P',
        referenceImageUrl: 'https://example.com/c.png',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('accepts first-frame image-to-video', async () => {
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
        durationSeconds: 6,
        resolution: '1080P',
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
      model: 'MiniMax-Hailuo-2.3',
      durationSeconds: 6,
      aspectRatio: 'native',
      resolution: '768P',
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
      durationSeconds: 6,
      resolution: '768P',
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
      { values: {}, durationSeconds: 6, resolution: '768P', mockScenario: 'success' },
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
    // Corrupt persisted params: missing duration (cannot retry under the
    // current model contract).
    const failed = plantFailedJob(
      created.body.prompt.id,
      created.body.versions[0].id,
      'src-failed-corrupt',
      { values: {}, resolution: '768P' },
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

describe('body-parser failures keep the safe request-id / envelope contract', () => {
  it('returns 400 bad_request for malformed JSON with a real (non-unknown) request id', async () => {
    // Raw malformed JSON with an explicit application/json content type so the
    // express.json middleware attempts to parse it (and fails).
    const res = await request(app)
      .post('/api/prompts')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'parse-fail-1')
      .send('{ this is not valid json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    // Parse/size failures must share the same request-id contract as every other
    // API failure: a real id (never "unknown") echoed in both the header and the
    // error envelope.
    expect(res.body.error.requestId).toBe('parse-fail-1');
    expect(res.headers['x-request-id']).toBe('parse-fail-1');
    // The parser's internal message / body fragment is never leaked.
    expect(res.body.error.message).not.toMatch(/this is not valid json/i);
    expect(res.body.error.message).toMatch(/parsed as JSON/i);
  });

  it('returns 413 bad_request for a body larger than the configured 1 MiB limit', async () => {
    // ~1.05 MiB of JSON, comfortably above the 1 MiB express.json limit.
    const oversized = JSON.stringify({ padding: 'x'.repeat(1_100_000) });
    const res = await request(app)
      .post('/api/prompts')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'too-large-1')
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.requestId).toBe('too-large-1');
    expect(res.headers['x-request-id']).toBe('too-large-1');
    expect(res.body.error.message).toMatch(/exceeds the maximum allowed size/i);
  });

  it('returns 415 bad_request for an unsupported JSON charset with a real request id and a safe message', async () => {
    // body-parser rejects any non-utf-* charset before parsing
    // (lib/types/json.js): `application/json; charset=iso-8859-1` throws a
    // typed `charset.unsupported` error that must map to a safe 415, not the
    // generic 500/internal_error path.
    const res = await request(app)
      .post('/api/prompts')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .set('X-Request-Id', 'charset-1')
      .send('{"name":"x","content":"x"}');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('bad_request');
    // The parser failure must share the same request-id contract as every other
    // API failure: a real id (never "unknown") echoed in both header and body.
    expect(res.body.error.requestId).toBe('charset-1');
    expect(res.headers['x-request-id']).toBe('charset-1');
    expect(res.body.error.requestId).not.toBe('unknown');
    // Only a safe static message — never the charset value or parser internals.
    expect(res.body.error.message).toBe('The request content type or encoding is not supported.');
    expect(res.body.error.message).not.toMatch(/iso-8859-1/i);
  });

  it('returns 415 bad_request for an unsupported request content encoding with a real request id and a safe message', async () => {
    // body-parser's read path (lib/read.js -> contentstream) throws a typed
    // `encoding.unsupported` error synchronously for any Content-Encoding it
    // cannot inflate (neither identity/gzip/deflate), e.g. `br`. Supertest
    // produces this request deterministically by sending the header verbatim,
    // so this is exercised end-to-end (no paid provider, no real decoding).
    const res = await request(app)
      .post('/api/prompts')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'br')
      .set('X-Request-Id', 'encoding-1')
      .send('{"name":"x","content":"x"}');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.requestId).toBe('encoding-1');
    expect(res.headers['x-request-id']).toBe('encoding-1');
    expect(res.body.error.requestId).not.toBe('unknown');
    expect(res.body.error.message).toBe('The request content type or encoding is not supported.');
    expect(res.body.error.message).not.toMatch(/\bbr\b/i);
  });

  it('control: a valid request still succeeds (parser/limit do not block normal traffic)', async () => {
    const res = await request(app)
      .post('/api/prompts')
      .send({ name: 'Valid control', content: 'x' })
      .expect(201);
    expect(res.body.prompt.id).toBeTruthy();
  });
});
