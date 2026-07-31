import { describe, expect, it } from 'vitest';
import { ProviderErrorCategory } from '@h3/shared';
import {
  classifyHttpFailure,
  classifyTaskFailureCategory,
  extractResultUrl,
  extractTaskFailure,
  extractTaskId,
  isTerminalStatus,
  mapQueryResult,
  mapTaskStatus,
} from './minimaxMapping.js';

describe('mapTaskStatus', () => {
  it('maps the documented H3 V2 statuses', () => {
    expect(mapTaskStatus('queued')).toBe('queued');
    expect(mapTaskStatus('running')).toBe('running');
    expect(mapTaskStatus('succeeded')).toBe('succeeded');
    expect(mapTaskStatus('failed')).toBe('failed');
    expect(mapTaskStatus('expired')).toBe('expired');
  });

  it('maps cancelled/canceled to a terminal failed state (no silent forever-poll)', () => {
    expect(mapTaskStatus('cancelled')).toBe('failed');
    expect(mapTaskStatus('Canceled')).toBe('failed');
    expect(isTerminalStatus(mapTaskStatus('cancelled'))).toBe(true);
  });

  it('is case-insensitive and tolerates the success alias', () => {
    expect(mapTaskStatus('Success')).toBe('succeeded');
    expect(mapTaskStatus('RUNNING')).toBe('running');
  });

  it('defaults unknown states to running (bounded attempts guarantee termination)', () => {
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

describe('classifyHttpFailure (OpenAI-style envelope)', () => {
  const envelope = (http_code: number, message = 'msg', type = 'error') => ({
    type: 'error',
    error: { type, message, http_code },
    request_id: 'req-1',
  });

  it('classifies 400 as invalid_request', () => {
    expect(
      classifyHttpFailure({ status: 400, body: envelope(400) }).category,
    ).toBe(ProviderErrorCategory.INVALID_REQUEST);
  });

  it('classifies 401 as auth', () => {
    expect(
      classifyHttpFailure({ status: 401, body: envelope(401) }).category,
    ).toBe(ProviderErrorCategory.AUTH);
  });

  it('classifies 402 as insufficient_balance', () => {
    expect(
      classifyHttpFailure({ status: 402, body: envelope(402) }).category,
    ).toBe(ProviderErrorCategory.INSUFFICIENT_BALANCE);
  });

  it('classifies 422 as content_moderation', () => {
    expect(
      classifyHttpFailure({ status: 422, body: envelope(422) }).category,
    ).toBe(ProviderErrorCategory.CONTENT_MODERATION);
  });

  it('classifies 429 as rate_limit', () => {
    expect(
      classifyHttpFailure({ status: 429, body: envelope(429) }).category,
    ).toBe(ProviderErrorCategory.RATE_LIMIT);
  });

  it('classifies 500 and 529 as provider_failure', () => {
    expect(
      classifyHttpFailure({ status: 500, body: envelope(500) }).category,
    ).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
    expect(
      classifyHttpFailure({ status: 529, body: envelope(529) }).category,
    ).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });

  it('uses the envelope message', () => {
    const r = classifyHttpFailure({ status: 401, body: envelope(401, 'bad key') });
    expect(r.message).toBe('bad key');
  });

  it('falls back to the HTTP status when the envelope omits http_code', () => {
    expect(
      classifyHttpFailure({
        status: 429,
        body: { type: 'error', error: { type: 'error', message: 'slow down' } },
      }).category,
    ).toBe(ProviderErrorCategory.RATE_LIMIT);
  });

  it('uses keyword heuristics for a non-explicit status when no http_code is present', () => {
    expect(
      classifyHttpFailure({
        // 403 is not one of the explicitly classified codes, so the message
        // keyword drives the category.
        status: 403,
        body: { error: { message: 'Insufficient credit balance.' } },
      }).category,
    ).toBe(ProviderErrorCategory.INSUFFICIENT_BALANCE);
  });
});

describe('query response extractors (nested task envelope)', () => {
  it('extracts the result url from task.content.url on success', () => {
    expect(
      extractResultUrl({
        task: { status: 'succeeded', content: { url: 'https://x/v.mp4' } },
      }),
    ).toBe('https://x/v.mp4');
  });

  it('returns undefined when there is no result url', () => {
    expect(extractResultUrl({ task: { status: 'running' } })).toBeUndefined();
    expect(extractResultUrl({})).toBeUndefined();
  });

  it('extracts provider failure details from task.error', () => {
    expect(
      extractTaskFailure({
        task: { status: 'failed', error: { message: 'flagged', code: 'SAFETY' } },
      }),
    ).toEqual({ message: 'flagged', code: 'SAFETY' });
    expect(extractTaskFailure({ task: { status: 'succeeded' } })).toBeUndefined();
  });

  it('extracts the task id from create/query responses', () => {
    expect(extractTaskId({ task_id: 'abc' })).toBe('abc');
    expect(extractTaskId({ task: { task_id: 'def' } })).toBe('def');
    expect(extractTaskId({})).toBeUndefined();
  });
});

describe('classifyTaskFailureCategory (async task.error taxonomy)', () => {
  it('classifies moderation signals as content_moderation', () => {
    expect(
      classifyTaskFailureCategory({ message: 'flagged', code: 'CONTENT_RISK' }),
    ).toBe(ProviderErrorCategory.CONTENT_MODERATION);
    expect(
      classifyTaskFailureCategory({ message: 'blocked by safety review' }),
    ).toBe(ProviderErrorCategory.CONTENT_MODERATION);
  });

  it('classifies balance signals as insufficient_balance', () => {
    expect(
      classifyTaskFailureCategory({ message: 'no credits left', code: 'INSUFFICIENT_BALANCE' }),
    ).toBe(ProviderErrorCategory.INSUFFICIENT_BALANCE);
    expect(classifyTaskFailureCategory({ message: 'insufficient balance' })).toBe(
      ProviderErrorCategory.INSUFFICIENT_BALANCE,
    );
  });

  it('classifies rate-limit signals as rate_limit', () => {
    expect(
      classifyTaskFailureCategory({ message: 'too many requests', code: 429 }),
    ).toBe(ProviderErrorCategory.RATE_LIMIT);
  });

  it('falls back to provider_failure for generic/unknown errors', () => {
    expect(classifyTaskFailureCategory({ message: 'something went wrong' })).toBe(
      ProviderErrorCategory.PROVIDER_FAILURE,
    );
    expect(
      classifyTaskFailureCategory({ message: 'oops', code: 'INTERNAL_X' }),
    ).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });
});

describe('mapQueryResult', () => {
  it('maps a succeeded task with a result url', () => {
    expect(
      mapQueryResult({
        task: { status: 'succeeded', content: { url: 'https://x/v.mp4' } },
      }),
    ).toEqual({ status: 'succeeded', resultUrl: 'https://x/v.mp4' });
  });

  it('maps a running task with no url and no failure', () => {
    expect(mapQueryResult({ task: { status: 'running' } })).toEqual({
      status: 'running',
    });
  });

  it('converts succeeded WITHOUT a usable url into a recoverable failed failure', () => {
    const out = mapQueryResult({ task: { status: 'succeeded' } });
    expect(out.status).toBe('failed'); // not succeeded → still retryable
    expect(out.failure?.category).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
    expect(out.failure?.message).toMatch(/no usable result URL/i);
    // No resultUrl leaked onto a failed-convert.
    expect(out.resultUrl).toBeUndefined();
  });

  it('converts succeeded with an empty content url into a recoverable failed failure', () => {
    const out = mapQueryResult({
      task: { status: 'succeeded', content: { url: '' } },
    });
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });

  it('classifies a failed task.error by its stable code instead of always provider_failure', () => {
    const out = mapQueryResult({
      task: { status: 'failed', error: { message: 'blocked', code: 'SAFETY_RISK' } },
    });
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe(ProviderErrorCategory.CONTENT_MODERATION);
    expect(out.failure?.message).toBe('blocked');
  });

  it('maps a balance task.error to insufficient_balance', () => {
    expect(
      mapQueryResult({
        task: { status: 'failed', error: { message: 'insufficient balance', code: 402 } },
      }).failure?.category,
    ).toBe(ProviderErrorCategory.INSUFFICIENT_BALANCE);
  });

  it('maps a rate-limit task.error to rate_limit', () => {
    expect(
      mapQueryResult({
        task: { status: 'failed', error: { message: 'rate limited', code: 429 } },
      }).failure?.category,
    ).toBe(ProviderErrorCategory.RATE_LIMIT);
  });

  it('maps a generic failed task.error to provider_failure', () => {
    expect(
      mapQueryResult({
        task: { status: 'failed', error: { message: 'internal error', code: 'X' } },
      }).failure?.category,
    ).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });

  it('maps cancelled to a terminal failed status with no failure', () => {
    expect(mapQueryResult({ task: { status: 'cancelled' } })).toEqual({
      status: 'failed',
    });
  });
});
