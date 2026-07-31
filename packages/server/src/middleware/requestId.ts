/**
 * Request-id middleware. Every request gets an id (from the `X-Request-Id`
 * header when provided and safe, otherwise generated) and tags the response
 * header so clients can trace a request end-to-end.
 *
 * The incoming id is validated against a bounded, control-character-free safe
 * set. A malicious or malformed value (newlines, control bytes, overlong ids)
 * is never echoed back — preventing header/log injection — and a fresh id is
 * generated instead.
 */

import type { Request, Response, NextFunction } from 'express';
import { newId } from '../util.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Safe characters for a request id: unreserved ASCII plus a few separators,
 * 1–128 chars. Crucially this excludes control characters (CR/LF/TAB) and any
 * byte that could forge additional headers or corrupt log lines.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isSafeRequestId(value: string): boolean {
  return SAFE_REQUEST_ID.test(value);
}

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id =
    incoming && isSafeRequestId(incoming) ? incoming : newId();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
