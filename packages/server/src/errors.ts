/**
 * Server-side API error. Thrown by services/routes and translated into the
 * shared error envelope by the error middleware. Carries a stable code and an
 * HTTP status. Never embeds secrets or rendered media payloads.
 */

import { ErrorCode, type ErrorCode as ErrorCodeType } from '@h3/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCodeType;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCodeType,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
  }
}

function defaultStatus(code: ErrorCodeType): number {
  switch (code) {
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.INVALID_TEMPLATE:
    case ErrorCode.UNRESOLVED_VARIABLE:
    case ErrorCode.BAD_REQUEST:
      return 400;
    case ErrorCode.NOT_FOUND:
      return 404;
    case ErrorCode.CONFLICT:
    case ErrorCode.IDEMPOTENCY_CONFLICT:
    case ErrorCode.ARCHIVED:
      return 409;
    case ErrorCode.UNPROCESSABLE:
      return 422;
    case ErrorCode.PROVIDER_ERROR:
    case ErrorCode.PROVIDER_UNAVAILABLE:
    case ErrorCode.INTERNAL_ERROR:
    default:
      return 500;
  }
}

export function notFound(message: string): ApiError {
  return new ApiError(ErrorCode.NOT_FOUND, message);
}

export function badRequest(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(ErrorCode.BAD_REQUEST, message, { details });
}

export function validationError(
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(ErrorCode.VALIDATION_ERROR, message, { details });
}
