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

type ExpressError = Error & { status?: number; code?: string };

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
  // Unexpected error — never leak internals.
  console.error(`[error] request=${getRequestId(res)} message=${err.message}`);
  writeError(
    res,
    new ApiError(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.', {
      status: 500,
    }),
  );
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
