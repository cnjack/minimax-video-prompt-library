/**
 * H3 API policy — the single source of truth for official MiniMax H3 V2
 * video-generation constraints.
 *
 * Source of truth: MiniMax platform docs
 * `api-reference/video-generation-v2-create.md` and
 * `video-generation-v2-query.md` for model `MiniMax-H3`. Update this module
 * when the official contract changes; UI logic and the provider payload builder
 * read these values rather than hardcoding them.
 *
 * Official H3 V2 contract (per the docs):
 *  - `POST {base}/v2/video_generation`, model `MiniMax-H3`.
 *  - `content[]` is a multimodal array: one nonempty text item (max
 *    `H3_MAX_PROMPT_CHARS`) plus independent media items carrying a `role`
 *    (`first_frame` | `last_frame` | `reference_image` | `reference_video` |
 *    `reference_audio`).
 *  - Top-level `ratio` (NOT `aspect_ratio`). Values: `adaptive` plus the
 *    concrete ratios in `H3_CONCRETE_RATIOS`. Text-to-video requires a concrete
 *    ratio; first/last-frame mode is `adaptive`; reference mode may use either.
 *  - `resolution` is required and currently `2K` only; `duration` is an integer
 *    in `[4, 15]`.
 *  - Media cross-field rules (enforced here so they are shared by UI and API):
 *    first/last-frame mode and reference-media mode are mutually exclusive;
 *    `last_frame` requires `first_frame`; reference audio cannot be used alone
 *    (it requires a reference image or video).
 */

export const H3_MODEL = 'MiniMax-H3';

/**
 * H3 supports durations from 4 to 15 seconds inclusive (integers).
 */
export const H3_MIN_DURATION_SECONDS = 4;
export const H3_MAX_DURATION_SECONDS = 15;

/**
 * The special adaptive ratio. Used by first/last-frame mode and optionally by
 * reference mode; never valid for plain text-to-video.
 */
export const H3_ADAPTIVE_RATIO = 'adaptive';

/**
 * Explicit, non-adaptive ratios supported by H3. Required for text-to-video.
 */
export const H3_CONCRETE_RATIOS = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
] as const;

/**
 * All accepted `ratio` values: `adaptive` plus every concrete ratio. This is
 * the complete value set the API accepts and the UI offers.
 */
export const H3_RATIOS = [H3_ADAPTIVE_RATIO, ...H3_CONCRETE_RATIOS] as const;

export type H3Ratio = (typeof H3_RATIOS)[number];
export type H3ConcreteRatio = (typeof H3_CONCRETE_RATIOS)[number];

/**
 * Backwards-compatible alias. The local domain stores the selected value as
 * `aspectRatio`; the provider payload builder maps it to the top-level `ratio`.
 */
export const H3_ASPECT_RATIOS = H3_RATIOS;
export type H3AspectRatio = H3Ratio;

/**
 * H3 resolution. Advertised honestly as 2K only — the UI must not offer
 * unsupported resolutions.
 */
export const H3_RESOLUTION = '2K';

export const H3_RESOLUTIONS = [H3_RESOLUTION] as const;
export type H3Resolution = (typeof H3_RESOLUTIONS)[number];

/**
 * Official H3 limit on the rendered text item length. Enforced server-side on
 * the rendered prompt (after variable substitution) before provider submission.
 */
export const H3_MAX_PROMPT_CHARS = 7000;

export function isValidDuration(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= H3_MIN_DURATION_SECONDS &&
    seconds <= H3_MAX_DURATION_SECONDS
  );
}

export function isSupportedRatio(value: string): value is H3Ratio {
  return (H3_RATIOS as readonly string[]).includes(value);
}

export function isConcreteRatio(value: string): value is H3ConcreteRatio {
  return (H3_CONCRETE_RATIOS as readonly string[]).includes(value);
}

export function isAdaptiveRatio(value: string): boolean {
  return value === H3_ADAPTIVE_RATIO;
}

export function isSupportedResolution(value: string): value is H3Resolution {
  return (H3_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * Which generation mode a set of media inputs selects. The modes are mutually
 * exclusive per the H3 contract; see `validateMediaCombination`.
 */
export type MediaMode = 'text' | 'frame' | 'reference';

export interface MediaInputs {
  firstFrameUrl?: string | null;
  lastFrameUrl?: string | null;
  referenceImageUrl?: string | null;
  referenceVideoUrl?: string | null;
  referenceAudioUrl?: string | null;
}

export function mediaMode(inputs: MediaInputs): MediaMode {
  const frame = Boolean(inputs.firstFrameUrl) || Boolean(inputs.lastFrameUrl);
  const reference =
    Boolean(inputs.referenceImageUrl) ||
    Boolean(inputs.referenceVideoUrl) ||
    Boolean(inputs.referenceAudioUrl);
  if (frame) return 'frame';
  if (reference) return 'reference';
  return 'text';
}

export interface MediaValidationError {
  field: keyof MediaInputs;
  message: string;
}

/**
 * Enforce the H3 media cross-field rules. Returns a list of violations (empty
 * when valid) so the UI and API surface the exact reason(s) to the user.
 *
 *  - first/last-frame mode and reference-media mode are mutually exclusive;
 *  - `last_frame` requires `first_frame`;
 *  - reference audio cannot be used alone (it needs a reference image/video).
 */
export function validateMediaCombination(
  inputs: MediaInputs,
): MediaValidationError[] {
  const errors: MediaValidationError[] = [];

  const hasFirst = Boolean(inputs.firstFrameUrl);
  const hasLast = Boolean(inputs.lastFrameUrl);
  const hasRefImage = Boolean(inputs.referenceImageUrl);
  const hasRefVideo = Boolean(inputs.referenceVideoUrl);
  const hasRefAudio = Boolean(inputs.referenceAudioUrl);

  const frameMode = hasFirst || hasLast;
  const referenceMode = hasRefImage || hasRefVideo || hasRefAudio;

  if (hasLast && !hasFirst) {
    errors.push({
      field: 'lastFrameUrl',
      message: 'A last frame requires a first frame image.',
    });
  }

  if (frameMode && referenceMode) {
    errors.push({
      field: 'firstFrameUrl',
      message:
        'First/last-frame mode and reference media are mutually exclusive.',
    });
  }

  if (hasRefAudio && !hasRefImage && !hasRefVideo) {
    errors.push({
      field: 'referenceAudioUrl',
      message: 'Reference audio requires a reference image or video.',
    });
  }

  return errors;
}

export interface RatioValidationError {
  message: string;
}

/**
 * Conditional ratio behavior, honestly enforced per the H3 contract:
 *  - text-to-video requires a concrete (non-adaptive) ratio;
 *  - first/last-frame mode requires `adaptive` (a concrete ratio is invalid);
 *  - reference mode may use `adaptive` or a concrete ratio.
 *
 * Returns an error when the chosen ratio is incompatible with the media mode.
 */
export function validateRatioForMode(
  ratio: string,
  inputs: MediaInputs,
): RatioValidationError | null {
  const mode = mediaMode(inputs);
  if (mode === 'text' && isAdaptiveRatio(ratio)) {
    return {
      message:
        'Text-to-video requires an explicit aspect ratio; "adaptive" is only valid with a first/last frame or reference media.',
    };
  }
  if (mode === 'frame' && !isAdaptiveRatio(ratio)) {
    return {
      message:
        'First/last-frame mode requires the "adaptive" aspect ratio; choose adaptive or remove the frame media.',
    };
  }
  return null;
}
