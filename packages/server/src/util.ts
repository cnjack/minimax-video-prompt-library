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
 */
export function computePayloadHash(input: {
  promptVersionId: string;
  values: Record<string, string>;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrl?: string;
  referenceVideoUrl?: string;
  referenceAudioUrl?: string;
}): string {
  const normalized = {
    promptVersionId: input.promptVersionId,
    durationSeconds: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    values: sortRecord(input.values),
    urls: sortRecord({
      firstFrameUrl: input.firstFrameUrl ?? '',
      lastFrameUrl: input.lastFrameUrl ?? '',
      referenceImageUrl: input.referenceImageUrl ?? '',
      referenceVideoUrl: input.referenceVideoUrl ?? '',
      referenceAudioUrl: input.referenceAudioUrl ?? '',
    }),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Detect a SQLite UNIQUE-constraint violation thrown by `node:sqlite`.
 *
 * `node:sqlite` exposes the SQLite extended error code as `errcode`:
 * 19 = SQLITE_CONSTRAINT, 2067 = SQLITE_CONSTRAINT_UNIQUE. We treat either as a
 * unique race (belt-and-braces with the English message SQLite emits).
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const anyError = error as Error & { errcode?: unknown };
  const errcode =
    typeof anyError.errcode === 'number' ? anyError.errcode : undefined;
  if (errcode === 2067 || errcode === 19) {
    return true;
  }
  return /unique constraint failed/i.test(error.message);
}
