/**
 * MiniMax video-generation policy — the single source of truth for the official
 * MiniMax-Hailuo-2.3 general video API constraints.
 *
 * Source of truth (current official contract):
 *  - https://platform.minimax.io/docs/api-reference/video-generation-t2v
 *  - https://platform.minimax.io/docs/api-reference/video-generation-i2v
 *  - https://platform.minimax.io/docs/api-reference/video-generation-query
 *  - https://platform.minimax.io/docs/api-reference/video-generation-download
 *
 * Update this module when the official contract changes; the UI, the API
 * schemas, and the provider payload builder read these values rather than
 * hardcoding them.
 *
 * Official MiniMax-Hailuo-2.3 contract (per the docs):
 *  - `POST {base}/v1/video_generation`, model `MiniMax-Hailuo-2.3`.
 *  - The request body is FLAT: top-level `prompt`, `duration`, `resolution`
 *    (and `first_frame_image` for image-to-video). There is NO `content[]`
 *    array, NO `role`, and NO `ratio`/`aspect_ratio` field.
 *  - `prompt` is a string up to {@link MINIMAX_MAX_PROMPT_CHARS} (2000) chars.
 *  - `duration` is an integer: `6` or `10` (see {@link MINIMAX_DURATIONS}).
 *  - `resolution` is `768P` or `1080P`, but 10-second video is only supported at
 *    `768P` — `1080P` is only available at 6 seconds
 *    (see {@link isDurationResolutionCompatible}).
 *  - Image-to-video uses a single `first_frame_image` URL. Last-frame and
 *    reference image/video/audio inputs are NOT supported by this model.
 */

/**
 * The only model this provider targets. The legacy `MiniMax-H3` / `/v2`
 * contract is obsolete and must not be sent.
 */
export const MINIMAX_MODEL = 'MiniMax-Hailuo-2.3';

/**
 * Official limit on the rendered `prompt` length. Enforced server-side on the
 * rendered prompt (after variable substitution) before provider submission.
 */
export const MINIMAX_MAX_PROMPT_CHARS = 2000;

/**
 * Supported durations, in seconds. Hailuo-2.3 accepts only `6` or `10`.
 */
export const MINIMAX_DURATIONS = [6, 10] as const;
export type MinimaxDuration = (typeof MINIMAX_DURATIONS)[number];

export const MINIMAX_MIN_DURATION_SECONDS = Math.min(...MINIMAX_DURATIONS);
export const MINIMAX_MAX_DURATION_SECONDS = Math.max(...MINIMAX_DURATIONS);

/**
 * Supported resolutions. Hailuo-2.3 accepts `768P` (the default) or `1080P`.
 */
export const MINIMAX_RESOLUTION_768P = '768P';
export const MINIMAX_RESOLUTION_1080P = '1080P';
export const MINIMAX_RESOLUTIONS = [
  MINIMAX_RESOLUTION_768P,
  MINIMAX_RESOLUTION_1080P,
] as const;
export type MinimaxResolution = (typeof MINIMAX_RESOLUTIONS)[number];

/** Default resolution used by the UI when none is chosen. */
export const MINIMAX_DEFAULT_RESOLUTION: MinimaxResolution =
  MINIMAX_RESOLUTION_768P;

/**
 * Hailuo-2.3 only supports 10-second video at 768P; 1080P is only available at
 * 6 seconds. This encodes that cross-field rule so the UI and API share it.
 *
 * Official duration/resolution matrix for MiniMax-Hailuo-2.3:
 *   |          | 768P (default) | 1080P |
 *   | 6s       | yes             | yes   |
 *   | 10s      | yes             | no    |
 */
export function isDurationResolutionCompatible(
  duration: number,
  resolution: string,
): boolean {
  return !(duration === 10 && resolution === MINIMAX_RESOLUTION_1080P);
}

export function isValidDuration(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    (MINIMAX_DURATIONS as readonly number[]).includes(seconds)
  );
}

export function isSupportedResolution(value: string): value is MinimaxResolution {
  return (MINIMAX_RESOLUTIONS as readonly string[]).includes(value);
}

export interface DurationResolutionError {
  message: string;
}

/**
 * Validate the duration/resolution cross-field rule. Returns an error when the
 * combination is unsupported by MiniMax-Hailuo-2.3 (currently only 10s + 1080P).
 */
export function validateDurationResolution(
  duration: number,
  resolution: string,
): DurationResolutionError | null {
  if (!isDurationResolutionCompatible(duration, resolution)) {
    return {
      message:
        '10-second video is only supported at 768P; choose 768P or a 6-second duration.',
    };
  }
  return null;
}

/**
 * Which generation mode a set of media inputs selects. MiniMax-Hailuo-2.3
 * supports text-to-video and first-frame image-to-video only.
 */
export type MediaMode = 'text' | 'first_frame';

export interface MediaInputs {
  firstFrameUrl?: string | null;
}

export function mediaMode(inputs: MediaInputs): MediaMode {
  return inputs.firstFrameUrl ? 'first_frame' : 'text';
}

export interface MediaValidationError {
  field: string;
  message: string;
}

/**
 * Enforce the Hailuo-2.3 media rules. With only a first-frame image supported,
 * any valid combination is accepted (first frame alone is valid). Unsupported
 * media (last frame, reference image/video/audio) is rejected earlier by the
 * API schema; this helper is kept as the shared, testable policy seam.
 */
export function validateMediaCombination(
  inputs: MediaInputs,
): MediaValidationError[] {
  void inputs;
  return [];
}
