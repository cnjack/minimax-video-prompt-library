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
 * parser's `message` (which contains attacker-controlled body fragments and
 * internal offsets) and avoids fragile message-substring matching.
 *
 *   entity.too.large     -> 413 (the configured 1 MiB body limit was exceeded)
 *   entity.parse.failed  -> 400 (malformed JSON)
 *
 * `encoding.failed`, `request.size.invalid`, and `request.abort` are likewise
 * client-side body problems and are mapped to the same safe 400. Other parser
 * types (charset/encoding unsupported, verify) are intentionally left to fall
 * through to the generic handler; they are not reachable through express.json.
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
    case 'encoding.failed':
    case 'request.size.invalid':
    case 'request.abort':
      return new ApiError(
        ErrorCode.BAD_REQUEST,
        'The request body could not be parsed as JSON.',
        { status: 400 },
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
