import { describe, expect, it } from 'vitest';
import {
  MINIMAX_DEFAULT_RESOLUTION,
  MINIMAX_DURATIONS,
  MINIMAX_MAX_PROMPT_CHARS,
  MINIMAX_MODEL,
  MINIMAX_RESOLUTIONS,
  isDurationResolutionCompatible,
  isSupportedResolution,
  isValidDuration,
  mediaMode,
  validateDurationResolution,
  validateMediaCombination,
} from '../video-policy.js';

describe('MiniMax-Hailuo-2.3 model identity', () => {
  it('targets the current official model and never the legacy H3 model', () => {
    expect(MINIMAX_MODEL).toBe('MiniMax-Hailuo-2.3');
    expect(MINIMAX_MODEL).not.toBe('MiniMax-H3');
  });
});

describe('MiniMax rendered prompt limit', () => {
  it('documents the official 2000-character prompt limit', () => {
    expect(MINIMAX_MAX_PROMPT_CHARS).toBe(2000);
  });
});

describe('MiniMax duration policy', () => {
  it('accepts only 6 and 10 seconds', () => {
    expect(isValidDuration(6)).toBe(true);
    expect(isValidDuration(10)).toBe(true);
  });

  it('rejects every other value (no arbitrary 4–15s range)', () => {
    expect(isValidDuration(4)).toBe(false);
    expect(isValidDuration(5)).toBe(false);
    expect(isValidDuration(7)).toBe(false);
    expect(isValidDuration(15)).toBe(false);
    expect(isValidDuration(6.5)).toBe(false);
    expect(isValidDuration(11)).toBe(false);
  });

  it('exposes exactly the supported duration set', () => {
    expect([...MINIMAX_DURATIONS]).toEqual([6, 10]);
  });
});

describe('MiniMax resolution policy', () => {
  it('supports 768P (default) and 1080P only', () => {
    expect([...MINIMAX_RESOLUTIONS]).toEqual(['768P', '1080P']);
    expect(isSupportedResolution('768P')).toBe(true);
    expect(isSupportedResolution('1080P')).toBe(true);
    expect(isSupportedResolution('2K')).toBe(false);
    expect(MINIMAX_DEFAULT_RESOLUTION).toBe('768P');
  });
});

describe('duration/resolution cross-field rule (10s only at 768P)', () => {
  it('accepts 6s at either resolution', () => {
    expect(isDurationResolutionCompatible(6, '768P')).toBe(true);
    expect(isDurationResolutionCompatible(6, '1080P')).toBe(true);
  });

  it('accepts 10s only at 768P and rejects 10s at 1080P', () => {
    expect(isDurationResolutionCompatible(10, '768P')).toBe(true);
    expect(isDurationResolutionCompatible(10, '1080P')).toBe(false);
  });

  it('surfaces a clear validation error for 10s + 1080P', () => {
    expect(validateDurationResolution(6, '1080P')).toBeNull();
    expect(validateDurationResolution(10, '1080P')?.message).toMatch(/768P/i);
  });
});

describe('media mode (text + first-frame only)', () => {
  it('classifies text-to-video vs first-frame image-to-video', () => {
    expect(mediaMode({})).toBe('text');
    expect(mediaMode({ firstFrameUrl: 'https://x/a.png' })).toBe('first_frame');
    expect(mediaMode({ firstFrameUrl: null })).toBe('text');
  });

  it('accepts a first-frame image (the only supported media mode)', () => {
    expect(
      validateMediaCombination({ firstFrameUrl: 'https://x/a.png' }),
    ).toHaveLength(0);
    expect(validateMediaCombination({})).toHaveLength(0);
  });
});
