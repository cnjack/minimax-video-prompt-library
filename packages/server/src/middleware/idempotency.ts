/**
 * Per-attempt idempotency token handling for retry-style writes.
 *
 * Retry idempotency is driven by an EXPLICIT client-generated token sent in the
 * `Idempotency-Key` header (one token per user button click). This keeps
 * transport retries (same token → reuse, no second paid generation) distinct
 * from a later deliberate retry of the same source (new token → new job), which
 * the old derived `retry:<id>` key could not express.
 *
 * The token is validated and bounded server-side to prevent header/log
 * injection.
 */

import { ErrorCode } from '@h3/shared';
import { ApiError } from '../errors.js';
import { newId } from '../util.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Acceptable token charset: printable ASCII excluding space (0x21–0x7E),
 * 1–200 characters. This is control-character-free (no CR/LF/TAB → no header
 * injection) and bounded in length, while accepting UUIDs, nanoids, and typical
 * client tokens.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,200}$/;

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * Read a per-attempt idempotency token from the `Idempotency-Key` header.
 *  - Absent → generate a fresh random token (direct API use still works; it is
 *    simply non-idempotent across calls).
 *  - Present but invalid (empty, overlong, or containing control bytes/space) →
 *    reject with 400 BAD_REQUEST.
 */
export function readIdempotencyKey(headerValue: string | undefined): string {
  if (headerValue === undefined || headerValue.length === 0) {
    return newId();
  }
  if (!isValidIdempotencyKey(headerValue)) {
    throw new ApiError(
      ErrorCode.BAD_REQUEST,
      'The Idempotency-Key header must be 1–200 printable ASCII characters.',
    );
  }
  return headerValue;
}
