/**
 * Error middleware. Translates ApiError, Zod validation errors, and unexpected
 * errors into the consistent `{ error: ApiErrorBody }` envelope, always
 * including the request id. Logs without redacting are limited to safe messages
 * — authorization and rendered media are never logged elsewhere either.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ErrorCode, type ApiErrorBody } from '@h3/shared';
import { ApiError } from '../errors.js';

type ExpressError = Error & { status?: number; code?: string; type?: string };

export function notFound(_req: Request, res: Response): void {
  writeError(res, new ApiError(ErrorCode.NOT_FOUND, 'Resource not found.'));
}

export function errorHandler(
  err: ExpressError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    writeError(res, err);
    return;
  }
  if (err instanceof ZodError) {
    const body: ApiErrorBody = {
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed.',
      status: 400,
      requestId: getRequestId(res),
      details: { issues: err.issues.map((i) => ({ path: i.path, message: i.message })) },
    };
    res.status(400).json({ error: body });
    return;
  }
  const parserError = bodyParserError(err);
  if (parserError) {
    // Parser errors originate in the body-parsing phase, before any route ran,
    // so the response has normally never started. `request.aborted` is the one
    // exception: the client disconnected mid-body, so only reply while the
    // underlying socket is still writable.
    if (!res.writable) {
      return;
    }
    writeError(res, parserError);
    return;
  }
  // Unexpected error — never leak internals.
  console.error(`[error] request=${getRequestId(res)} message=${err.message}`);
  writeError(
    res,
    new ApiError(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.', {
      status: 500,
    }),
  );
}

/**
 * Recognize an express/body-parser JSON failure by its typed `type` field and
 * translate it into a safe, non-leaking ApiError. This avoids parsing the
 * parser's `message` (which carries attacker-controlled body fragments and
 * internal offsets) and avoids fragile message-substring matching. The type
 * values below are the real `createError` types emitted by the locked
 * body-parser 1.20.x / raw-body 2.5.x stack (body-parser lib/types/json.js and
 * lib/read.js; raw-body index.js).
 *
 *   entity.too.large     -> 413 (the configured 1 MiB body limit was exceeded)
 *   entity.parse.failed  -> 400 (malformed JSON)
 *   request.size.invalid -> 400 (a bad/unsatisfiable Content-Length)
 *   request.aborted      -> 400 (client disconnected mid-body; only replied to
 *                            while the response is still writable)
 *   charset.unsupported  -> 415 (a JSON charset that is not utf-*, emitted by
 *                            body-parser before parsing, e.g.
 *                            `application/json; charset=iso-8859-1`)
 *   encoding.unsupported -> 415 (an unsupported Content-Encoding, e.g. `br`)
 *
 * `stream.encoding.set` is intentionally NOT mapped: it signals server /
 * middleware misuse (raw-body refuses a stream whose encoding was already set)
 * and must stay on the generic 500 path rather than masquerade as a client
 * error. There is no `encoding.failed` or `request.abort` type in this stack —
 * the real aborted type is `request.aborted`.
 */
function bodyParserError(err: ExpressError): ApiError | null {
  switch (err.type) {
    case 'entity.too.large':
      return new ApiError(
        ErrorCode.BAD_REQUEST,
        'The request body exceeds the maximum allowed size.',
        { status: 413 },
      );
    case 'entity.parse.failed':
    case 'request.size.invalid':
    case 'request.aborted':
      return new ApiError(
        ErrorCode.BAD_REQUEST,
        'The request body could not be parsed as JSON.',
        { status: 400 },
      );
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return new ApiError(
        ErrorCode.BAD_REQUEST,
        'The request content type or encoding is not supported.',
        { status: 415 },
      );
    default:
      return null;
  }
}

function writeError(res: Response, error: ApiError): void {
  const body: ApiErrorBody = {
    code: error.code,
    message: error.message,
    status: error.status,
    requestId: getRequestId(res),
    details: error.details,
  };
  res.status(error.status).json({ error: body });
}

function getRequestId(res: Response): string {
  return (res.locals.requestId as string | undefined) ?? 'unknown';
}
