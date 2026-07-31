/**
 * Stable, machine-readable error codes and a consistent error envelope.
 *
 * Every API failure returns `{ error: ApiErrorBody }` with a stable `code`,
 * a human-readable `message`, an HTTP `status`, and the `requestId` used for
 * tracing. Rendered media payloads and secrets are never included.
 */

export const ErrorCode = {
  // 400 — client supplied something invalid.
  VALIDATION_ERROR: 'validation_error',
  INVALID_TEMPLATE: 'invalid_template',
  UNRESOLVED_VARIABLE: 'unresolved_variable',
  BAD_REQUEST: 'bad_request',
  // 404
  NOT_FOUND: 'not_found',
  // 409
  CONFLICT: 'conflict',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  ARCHIVED: 'archived',
  // 422 — well-formed but not acceptable for the current state.
  UNPROCESSABLE: 'unprocessable',
  // 5xx — provider / server.
  PROVIDER_ERROR: 'provider_error',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  /** Stable, machine-readable error code. */
  code: ErrorCode;
  /** Human-readable message safe to show to users. */
  message: string;
  /** HTTP status mirrored in the response. */
  status: number;
  /** Request identifier for tracing. */
  requestId: string;
  /** Optional structured details (e.g. field validation errors). */
  details?: Record<string, unknown>;
}

/**
 * Provider-level error categories mapped from MiniMax responses into stable
 * local codes. Kept separate from HTTP `ErrorCode` so provider adapters can be
 * tested in isolation.
 */
export const ProviderErrorCategory = {
  AUTH: 'auth',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  CONTENT_MODERATION: 'content_moderation',
  RATE_LIMIT: 'rate_limit',
  INVALID_REQUEST: 'invalid_request',
  PROVIDER_FAILURE: 'provider_failure',
} as const;

export type ProviderErrorCategory =
  (typeof ProviderErrorCategory)[keyof typeof ProviderErrorCategory];

/** Maps a provider error category to an HTTP-facing error code. */
export function categoryToErrorCode(
  category: ProviderErrorCategory,
): ErrorCode {
  switch (category) {
    case ProviderErrorCategory.AUTH:
    case ProviderErrorCategory.INVALID_REQUEST:
      return ErrorCode.PROVIDER_ERROR;
    case ProviderErrorCategory.INSUFFICIENT_BALANCE:
    case ProviderErrorCategory.CONTENT_MODERATION:
    case ProviderErrorCategory.RATE_LIMIT:
    case ProviderErrorCategory.PROVIDER_FAILURE:
      return ErrorCode.PROVIDER_ERROR;
  }
}
