/**
 * Camera-movement preset chips — a small, pure, dependency-free module.
 *
 * MiniMax's official Hailuo guide recommends camera-motion cues (pan, push/pull,
 * tracking, static, …). Rather than ask creators to remember or retype the
 * supported phrasing, the generation composer offers one-click "chips" that
 * insert a preset token at the current prompt cursor.
 *
 * The data (labels + inserted tokens) and the insertion logic live here so they
 * are testable in isolation and are not duplicated across UI surfaces. The
 * inserted token is ordinary prompt text; once inserted it is validated through
 * the same MiniMax request policy (character limit etc.) as any other prompt.
 *
 * Source: MiniMax platform guides
 * `guides/video-generation` (camera-motion cues for model `MiniMax-Hailuo-2.3`).
 */

/** A single camera-movement preset surfaced as a chip in the composer. */
export interface CameraPreset {
  /** Stable id for React keys / test selectors. */
  id: string;
  /** Human-readable chip label; doubles as the accessible name. */
  label: string;
  /** Exact text inserted into the prompt at the cursor. */
  token: string;
  /** Short description of the motion, used for tooltips/aria descriptions. */
  description: string;
}

/**
 * The minimum set of H3 camera-motion presets. Order is the chip order shown in
 * the UI. Keep this in one place so labels and tokens stay in sync and testable.
 */
export const CAMERA_PRESETS: readonly CameraPreset[] = [
  {
    id: 'pan-left',
    label: 'Pan left',
    token: 'pan left',
    description: 'Camera pans horizontally to the left.',
  },
  {
    id: 'pan-right',
    label: 'Pan right',
    token: 'pan right',
    description: 'Camera pans horizontally to the right.',
  },
  {
    id: 'push-in',
    label: 'Push in',
    token: 'push in',
    description: 'Camera moves forward, toward the subject.',
  },
  {
    id: 'pull-out',
    label: 'Pull out',
    token: 'pull out',
    description: 'Camera moves backward, away from the subject.',
  },
  {
    id: 'tracking-shot',
    label: 'Tracking shot',
    token: 'tracking shot',
    description: 'Camera follows the moving subject.',
  },
  {
    id: 'static-shot',
    label: 'Static shot',
    token: 'static shot',
    description: 'Fixed, unmoving camera.',
  },
];

/** Look up a preset by id (returns undefined when absent). */
export function findCameraPreset(id: string): CameraPreset | undefined {
  return CAMERA_PRESETS.find((preset) => preset.id === id);
}

/** Result of inserting a token into a text field. */
export interface TokenInsertResult {
  /** The new full text after insertion. */
  text: string;
  /** Caret position after the inserted token (collapsed selection). */
  selectionStart: number;
  selectionEnd: number;
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  const truncated = Math.trunc(value);
  if (truncated < 0) return 0;
  if (truncated > max) return max;
  return truncated;
}

/**
 * Insert `token` into `text` at the current selection, replacing any selected
 * range. A single space is added before and/or after the token only when the
 * neighbouring text does not already provide separation, so surrounding text is
 * preserved and the result reads naturally.
 *
 * The returned selection is collapsed to the end of the inserted token, matching
 * typical "insert" behavior in a text field.
 *
 * Selection indices outside `[0, text.length]` are clamped, and a non-finite
 * index (e.g. an uninitialized cursor) is treated as the end of the text.
 */
export function insertTokenAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  token: string,
): TokenInsertResult {
  const max = text.length;
  const rawStart = clampIndex(selectionStart, max);
  const rawEnd = clampIndex(selectionEnd, max);
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);

  const before = text.slice(0, start);
  const after = text.slice(end);

  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);

  const inserted =
    (needsLeadingSpace ? ' ' : '') +
    token +
    (needsTrailingSpace ? ' ' : '');

  const nextText = before + inserted + after;
  // Caret lands immediately after the inserted token (excluding any trailing
  // separator space) so it is clear where the insertion ended and a following
  // chip/keystroke continues naturally.
  const caret = before.length + (needsLeadingSpace ? 1 : 0) + token.length;

  return {
    text: nextText,
    selectionStart: caret,
    selectionEnd: caret,
  };
}
