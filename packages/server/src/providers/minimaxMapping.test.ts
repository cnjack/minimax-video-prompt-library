import { describe, expect, it } from 'vitest';
import { ProviderErrorCategory } from '@h3/shared';
import {
  classifyHttpFailure,
  extractResultUrl,
  extractTaskId,
  isTerminalStatus,
  mapTaskStatus,
} from './minimaxMapping.js';

describe('mapTaskStatus', () => {
  it('maps preparing/processing to running', () => {
    expect(mapTaskStatus('Prepare')).toBe('running');
    expect(mapTaskStatus('Processing')).toBe('running');
  });

  it('maps queued states', () => {
    expect(mapTaskStatus('queued')).toBe('queued');
    expect(mapTaskStatus('Pending')).toBe('queued');
  });

  it('maps terminal states', () => {
    expect(mapTaskStatus('Success')).toBe('succeeded');
    expect(mapTaskStatus('Fail')).toBe('failed');
    expect(mapTaskStatus('expired')).toBe('expired');
  });

  it('defaults unknown states to running', () => {
    expect(mapTaskStatus('whatever')).toBe('running');
    expect(mapTaskStatus(undefined)).toBe('running');
  });
});

describe('isTerminalStatus', () => {
  it.each(['succeeded', 'failed', 'expired'])('is terminal: %s', (s) => {
    expect(isTerminalStatus(s as never)).toBe(true);
  });
  it.each(['queued', 'running'])('is not terminal: %s', (s) => {
    expect(isTerminalStatus(s as never)).toBe(false);
  });
});

describe('classifyHttpFailure', () => {
  it('classifies auth errors', () => {
    const r = classifyHttpFailure({
      status: 401,
      body: { base_resp: { status_code: 1004, status_msg: 'invalid auth' } },
    });
    expect(r.category).toBe(ProviderErrorCategory.AUTH);
  });

  it('classifies insufficient balance', () => {
    const r = classifyHttpFailure({
      status: 400,
      body: { base_resp: { status_code: 1022, status_msg: 'no balance' } },
    });
    expect(r.category).toBe(ProviderErrorCategory.INSUFFICIENT_BALANCE);
  });

  it('classifies content moderation', () => {
    const r = classifyHttpFailure({
      status: 400,
      body: { message: 'Content was rejected by moderation.' },
    });
    expect(r.category).toBe(ProviderErrorCategory.CONTENT_MODERATION);
  });

  it('classifies rate limiting', () => {
    const r = classifyHttpFailure({ status: 429, body: { message: 'too many' } });
    expect(r.category).toBe(ProviderErrorCategory.RATE_LIMIT);
  });

  it('classifies generic 4xx as invalid request', () => {
    const r = classifyHttpFailure({ status: 400, body: { message: 'bad' } });
    expect(r.category).toBe(ProviderErrorCategory.INVALID_REQUEST);
  });

  it('classifies 5xx as provider failure', () => {
    const r = classifyHttpFailure({ status: 500, body: {} });
    expect(r.category).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });
});

describe('extractors', () => {
  it('extracts task id', () => {
    expect(extractTaskId({ task_id: 'abc' })).toBe('abc');
    expect(extractTaskId({})).toBeUndefined();
  });

  it('extracts result url from common fields', () => {
    expect(extractResultUrl({ download_url: 'https://x/v.mp4' })).toBe('https://x/v.mp4');
    expect(extractResultUrl({ videos: [{ url: 'https://x/2.mp4' }] })).toBe('https://x/2.mp4');
    expect(extractResultUrl({})).toBeUndefined();
  });
});
