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
