/**
 * H3 API policy — the single source of truth for official MiniMax H3
 * video-generation constraints.
 *
 * Source of truth: `POST https://api.minimaxi.com/v2/video_generation`
 * using model `MiniMax-H3`. Update this module when the official contract
 * changes; UI logic should read these values rather than hardcoding them.
 *
 * Per the PRD, text-to-video uses explicit (non-adaptive) aspect ratios so the
 * server can reject an H3-incompatible combination before it reaches the paid
 * provider. Resolution is represented honestly as `2K` only.
 */

export const H3_MODEL = 'MiniMax-H3';

/**
 * H3 supports durations from 4 to 15 seconds inclusive (integers).
 */
export const H3_MIN_DURATION_SECONDS = 4;
export const H3_MAX_DURATION_SECONDS = 15;

/**
 * Explicit, non-adaptive aspect ratios supported by H3 text-to-video.
 */
export const H3_ASPECT_RATIOS = [
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '1:1',
  '21:9',
] as const;

export type H3AspectRatio = (typeof H3_ASPECT_RATIOS)[number];

/**
 * H3 resolution. Advertised honestly as 2K only — the UI must not offer
 * unsupported resolutions.
 */
export const H3_RESOLUTION = '2K';

export const H3_RESOLUTIONS = [H3_RESOLUTION] as const;
export type H3Resolution = (typeof H3_RESOLUTIONS)[number];

export function isValidDuration(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= H3_MIN_DURATION_SECONDS &&
    seconds <= H3_MAX_DURATION_SECONDS
  );
}

export function isSupportedAspectRatio(value: string): value is H3AspectRatio {
  return (H3_ASPECT_RATIOS as readonly string[]).includes(value);
}

export function isSupportedResolution(value: string): value is H3Resolution {
  return (H3_RESOLUTIONS as readonly string[]).includes(value);
}
