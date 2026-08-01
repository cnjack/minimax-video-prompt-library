/** Small server-side helpers shared by services. */

import { createHash, randomUUID } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

/**
 * Stable hash of the generation inputs so idempotency can detect a same-key,
 * different-payload conflict. Keys are sorted for canonical comparison.
 *
 * Ordering is locale-independent UTF-16 code-unit comparison (NOT
 * `String.prototype.localeCompare`, which is collator/locale-dependent and can
 * order keys differently across environments, silently changing the hash for the
 * same logical payload). Code-unit ordering is deterministic everywhere.
 */
export function computePayloadHash(input: {
  promptVersionId: string;
  values: Record<string, string>;
  /** Rendered-prompt override (e.g. with inserted camera cues). */
  prompt?: string;
  durationSeconds: number;
  resolution: string;
  firstFrameUrl?: string;
}): string {
  const normalized = {
    promptVersionId: input.promptVersionId,
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
    prompt: input.prompt ?? '',
    values: sortRecord(input.values),
    urls: sortRecord({
      firstFrameUrl: input.firstFrameUrl ?? '',
    }),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Sort object keys by UTF-16 code unit (locale-independent, deterministic).
 * Exported for testing the ordering contract directly.
 */
export function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => compareCodeUnits(a, b)),
  );
}

/** Locale-independent comparison by UTF-16 code units. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Detect a SQLite UNIQUE-constraint violation thrown by `node:sqlite`.
 *
 * `node:sqlite` exposes the SQLite EXTENDED result code as `errcode`:
 *  - 2067 = SQLITE_CONSTRAINT_UNIQUE
 *  - 1555 = SQLITE_CONSTRAINT_PRIMARYKEY (also surfaces as a uniqueness race)
 * The primary code 19 (SQLITE_CONSTRAINT) is deliberately NOT treated as unique,
 * because it also covers NOT NULL (1299), FOREIGN KEY (787), and CHECK (275)
 * failures — those must never be misreported as an idempotency reuse. The English
 * message is matched narrowly ("UNIQUE constraint failed") as a belt-and-braces
 * fallback for fakes/environments that omit the numeric code.
 */
const UNIQUE_ERRCODES = new Set<number>([2067, 1555]);

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const anyError = error as Error & { errcode?: unknown };
  if (typeof anyError.errcode === 'number' && UNIQUE_ERRCODES.has(anyError.errcode)) {
    return true;
  }
  return /unique constraint failed/i.test(error.message);
}
