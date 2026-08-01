import { describe, expect, it } from 'vitest';
import { ProviderErrorCategory } from '@h3/shared';
import {
  baseRespFailure,
  classifyBaseResp,
  classifyHttpFailure,
  extractDownloadUrl,
  extractFileId,
  extractTaskId,
  isBaseRespError,
  isTerminalStatus,
  mapQueryResult,
  mapTaskStatus,
  readBaseResp,
} from './minimaxMapping.js';

describe('mapTaskStatus (flat Hailuo-2.3 status)', () => {
  it('maps the documented official states', () => {
    expect(mapTaskStatus('Preparing')).toBe('queued');
    expect(mapTaskStatus('Queueing')).toBe('queued');
    expect(mapTaskStatus('Processing')).toBe('running');
    expect(mapTaskStatus('Success')).toBe('succeeded');
    expect(mapTaskStatus('Fail')).toBe('failed');
  });

  it('is case-insensitive', () => {
    expect(mapTaskStatus('success')).toBe('succeeded');
    expect(mapTaskStatus('PROCESSING')).toBe('running');
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

describe('base_resp handling', () => {
  it('reads base_resp.status_code / status_msg', () => {
    expect(
      readBaseResp({ base_resp: { status_code: 0, status_msg: 'success' } }),
    ).toEqual({ statusCode: 0, statusMsg: 'success' });
    expect(readBaseResp({})).toEqual({});
  });

  it('treats a nonzero status_code as an error', () => {
    expect(isBaseRespError({ base_resp: { status_code: 0 } })).toBe(false);
    expect(isBaseRespError({ base_resp: { status_code: 1004 } })).toBe(true);
    expect(isBaseRespError({})).toBe(false);
  });

  it('classifies the documented base_resp codes', () => {
    expect(classifyBaseResp(1004)).toBe(ProviderErrorCategory.AUTH);
    expect(classifyBaseResp(1002)).toBe(ProviderErrorCategory.RATE_LIMIT);
    expect(classifyBaseResp(1026)).toBe(ProviderErrorCategory.CONTENT_MODERATION);
    expect(classifyBaseResp(1027)).toBe(ProviderErrorCategory.CONTENT_MODERATION);
    expect(classifyBaseResp(9999)).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });

  it('builds a typed failure from a nonzero base_resp', () => {
    expect(
      baseRespFailure({ base_resp: { status_code: 1004, status_msg: 'bad key' } }),
    ).toEqual({ category: ProviderErrorCategory.AUTH, message: 'bad key' });
    // Uses a generated message when status_msg is absent.
    expect(baseRespFailure({ base_resp: { status_code: 9999 } })?.message).toMatch(
      /9999/,
    );
    // status_code 0 / absent is not a failure.
    expect(baseRespFailure({ base_resp: { status_code: 0 } })).toBeUndefined();
    expect(baseRespFailure({})).toBeUndefined();
  });
});

describe('flat response extractors', () => {
  it('extracts task_id', () => {
    expect(extractTaskId({ task_id: 'abc' })).toBe('abc');
    expect(extractTaskId({})).toBeUndefined();
  });

  it('extracts file_id (string or numeric)', () => {
    expect(extractFileId({ file_id: '205258526306433' })).toBe('205258526306433');
    expect(extractFileId({ file_id: 12345 })).toBe('12345');
    expect(extractFileId({})).toBeUndefined();
  });

  it('extracts file.download_url from a retrieve response', () => {
    expect(
      extractDownloadUrl({ file: { download_url: 'https://x/v.mp4' } }),
    ).toBe('https://x/v.mp4');
    expect(extractDownloadUrl({})).toBeUndefined();
    expect(extractDownloadUrl({ file: {} })).toBeUndefined();
  });
});

describe('mapQueryResult', () => {
  it('maps Success by retrieving file_id -> file.download_url', async () => {
    const retrieve = (fileId: string) => {
      expect(fileId).toBe('file-1');
      return {
        file: { download_url: 'https://x/v.mp4' },
        base_resp: { status_code: 0, status_msg: 'success' },
      };
    };
    expect(
      await mapQueryResult(
        {
          task_id: 't1',
          status: 'Success',
          file_id: 'file-1',
          base_resp: { status_code: 0, status_msg: 'success' },
        },
        retrieve,
      ),
    ).toEqual({ status: 'succeeded', resultUrl: 'https://x/v.mp4' });
  });

  it('maps Preparing/Queueing to queued and Processing to running', async () => {
    expect((await mapQueryResult({ status: 'Preparing' })).status).toBe('queued');
    expect((await mapQueryResult({ status: 'Queueing' })).status).toBe('queued');
    expect((await mapQueryResult({ status: 'Processing' })).status).toBe('running');
  });

  it('maps Fail to a provider_failure', async () => {
    const out = await mapQueryResult({ status: 'Fail' });
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });

  it('treats a nonzero base_resp as a typed failure', async () => {
    const out = await mapQueryResult({
      status: 'Processing',
      base_resp: { status_code: 1004, status_msg: 'auth' },
    });
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe(ProviderErrorCategory.AUTH);
  });

  it('converts Success WITHOUT a file_id into a recoverable failure', async () => {
    const out = await mapQueryResult({
      status: 'Success',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
    expect(out.resultUrl).toBeUndefined();
  });

  it('converts a retrieve base_resp error into a typed failure', async () => {
    const out = await mapQueryResult(
      {
        status: 'Success',
        file_id: 'f1',
        base_resp: { status_code: 0, status_msg: 'success' },
      },
      () => ({ base_resp: { status_code: 1002, status_msg: 'rate limited' } }),
    );
    expect(out.status).toBe('failed');
    expect(out.failure?.category).toBe(ProviderErrorCategory.RATE_LIMIT);
  });

  it('converts Success whose retrieve yields no download_url into a failure', async () => {
    const out = await mapQueryResult(
      {
        status: 'Success',
        file_id: 'f1',
        base_resp: { status_code: 0, status_msg: 'success' },
      },
      () => ({ file: {}, base_resp: { status_code: 0 } }),
    );
    expect(out.status).toBe('failed');
    expect(out.failure?.message).toMatch(/download URL/i);
  });
});

describe('classifyHttpFailure', () => {
  it('prefers a nonzero base_resp over the HTTP status', () => {
    expect(
      classifyHttpFailure({
        status: 500,
        body: { base_resp: { status_code: 1004, status_msg: 'auth' } },
      }).category,
    ).toBe(ProviderErrorCategory.AUTH);
  });

  it('falls back to HTTP status semantics when base_resp is absent', () => {
    expect(
      classifyHttpFailure({ status: 401, body: {} }).category,
    ).toBe(ProviderErrorCategory.AUTH);
    expect(
      classifyHttpFailure({ status: 429, body: {} }).category,
    ).toBe(ProviderErrorCategory.RATE_LIMIT);
    expect(
      classifyHttpFailure({ status: 400, body: {} }).category,
    ).toBe(ProviderErrorCategory.INVALID_REQUEST);
    expect(
      classifyHttpFailure({ status: 503, body: {} }).category,
    ).toBe(ProviderErrorCategory.PROVIDER_FAILURE);
  });

  it('uses message-keyword heuristics for variants without base_resp', () => {
    expect(
      classifyHttpFailure({
        status: 403,
        body: { message: 'Insufficient credit balance.' },
      }).category,
    ).toBe(ProviderErrorCategory.INSUFFICIENT_BALANCE);
  });
});
