import { describe, expect, it } from 'vitest';
import {
  H3_ASPECT_RATIOS,
  H3_MAX_DURATION_SECONDS,
  H3_MIN_DURATION_SECONDS,
  H3_RESOLUTION,
  isSupportedAspectRatio,
  isValidDuration,
} from '../h3-policy.js';

describe('H3 duration policy', () => {
  it('accepts the lower and upper boundaries (4 and 15)', () => {
    expect(isValidDuration(4)).toBe(true);
    expect(isValidDuration(15)).toBe(true);
  });

  it('rejects values just outside the range', () => {
    expect(isValidDuration(3)).toBe(false);
    expect(isValidDuration(16)).toBe(false);
  });

  it('rejects non-integer durations', () => {
    expect(isValidDuration(4.5)).toBe(false);
  });

  it('documents the supported range', () => {
    expect(H3_MIN_DURATION_SECONDS).toBe(4);
    expect(H3_MAX_DURATION_SECONDS).toBe(15);
  });
});

describe('H3 aspect ratio policy', () => {
  it.each(H3_ASPECT_RATIOS)('supports %s', (ratio) => {
    expect(isSupportedAspectRatio(ratio)).toBe(true);
  });

  it('rejects unsupported / adaptive ratios', () => {
    expect(isSupportedAspectRatio('2.35:1')).toBe(false);
    expect(isSupportedAspectRatio('adaptive')).toBe(false);
    expect(isSupportedAspectRatio('')).toBe(false);
  });
});

describe('H3 resolution policy', () => {
  it('represents resolution honestly as 2K only', () => {
    expect(H3_RESOLUTION).toBe('2K');
  });
});
