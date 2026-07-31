import { describe, expect, it } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { isSafeRequestId, REQUEST_ID_HEADER, requestId } from '../middleware/requestId.js';

function runMiddleware(incoming: string | undefined): {
  id: string | undefined;
  headerName?: string;
  headerValue?: string;
} {
  const locals: { requestId?: string } = {};
  let headerName: string | undefined;
  let headerValue: string | undefined;
  const req = {
    header: (name: string) =>
      name.toLowerCase() === REQUEST_ID_HEADER ? incoming : undefined,
  } as unknown as Request;
  const res = {
    locals,
    setHeader: (name: string, value: string) => {
      headerName = name;
      headerValue = value;
    },
  } as unknown as Response;
  requestId(req, res, (() => undefined) as NextFunction);
  return { id: locals.requestId, headerName, headerValue };
}

describe('isSafeRequestId', () => {
  it('accepts safe ids', () => {
    expect(isSafeRequestId('abc-123_456.789:p')).toBe(true);
    expect(isSafeRequestId('a')).toBe(true);
  });

  it('rejects empty and overlong ids', () => {
    expect(isSafeRequestId('')).toBe(false);
    expect(isSafeRequestId('a'.repeat(129))).toBe(false);
  });

  it('rejects control characters (CR/LF/TAB/NUL) that enable header injection', () => {
    expect(isSafeRequestId('evil\r\nX-Inject: admin')).toBe(false);
    expect(isSafeRequestId('a\tb')).toBe(false);
    expect(isSafeRequestId('a\0b')).toBe(false);
    expect(isSafeRequestId('a\nb')).toBe(false);
  });

  it('rejects characters outside the safe set', () => {
    expect(isSafeRequestId('a b')).toBe(false); // space
    expect(isSafeRequestId('a/b')).toBe(false);
    expect(isSafeRequestId('a@b')).toBe(false);
  });
});

describe('requestId middleware', () => {
  it('echoes a safe inbound id and sets the response header', () => {
    const { id, headerName, headerValue } = runMiddleware('req-abc-123');
    expect(id).toBe('req-abc-123');
    expect(headerName).toBe('X-Request-Id');
    expect(headerValue).toBe('req-abc-123');
  });

  it('generates a fresh safe id when the inbound value has control characters', () => {
    const { id } = runMiddleware('evil\r\nX-Inject: admin');
    expect(id).toBeTruthy();
    expect(isSafeRequestId(id!)).toBe(true);
    expect(id).not.toContain('evil');
    expect(id).not.toContain('\n');
    expect(id).not.toContain('\r');
  });

  it('generates a fresh id when the inbound value is overlong', () => {
    const { id } = runMiddleware('a'.repeat(500));
    expect(id).toBeTruthy();
    expect(id!.length).toBeLessThan(500);
  });

  it('generates a fresh id when no header is provided', () => {
    const { id } = runMiddleware(undefined);
    expect(id).toBeTruthy();
    expect(isSafeRequestId(id!)).toBe(true);
  });
});
