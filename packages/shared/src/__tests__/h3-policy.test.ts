import { describe, expect, it } from 'vitest';
import {
  H3_ADAPTIVE_RATIO,
  H3_CONCRETE_RATIOS,
  H3_MAX_DURATION_SECONDS,
  H3_MAX_PROMPT_CHARS,
  H3_MIN_DURATION_SECONDS,
  H3_RATIOS,
  H3_RESOLUTION,
  isAdaptiveRatio,
  isConcreteRatio,
  isSupportedRatio,
  isValidDuration,
  mediaMode,
  validateMediaCombination,
  validateRatioForMode,
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

describe('H3 ratio policy', () => {
  it('exposes adaptive plus every concrete ratio', () => {
    expect(H3_RATIOS).toEqual([
      'adaptive',
      '21:9',
      '16:9',
      '4:3',
      '1:1',
      '3:4',
      '9:16',
    ]);
    expect(H3_ADAPTIVE_RATIO).toBe('adaptive');
    expect(H3_CONCRETE_RATIOS).not.toContain('adaptive');
  });

  it.each(H3_RATIOS)('recognizes supported ratio %s', (ratio) => {
    expect(isSupportedRatio(ratio)).toBe(true);
  });

  it('distinguishes adaptive from concrete', () => {
    expect(isAdaptiveRatio('adaptive')).toBe(true);
    expect(isAdaptiveRatio('16:9')).toBe(false);
    expect(isConcreteRatio('16:9')).toBe(true);
    expect(isConcreteRatio('adaptive')).toBe(false);
  });

  it('rejects unsupported ratios', () => {
    expect(isSupportedRatio('2.35:1')).toBe(false);
    expect(isSupportedRatio('')).toBe(false);
  });
});

describe('H3 resolution policy', () => {
  it('represents resolution honestly as 2K only', () => {
    expect(H3_RESOLUTION).toBe('2K');
  });
});

describe('H3 rendered prompt limit', () => {
  it('documents the 7000-char text item limit', () => {
    expect(H3_MAX_PROMPT_CHARS).toBe(7000);
  });
});

describe('media mode + cross-field rules', () => {
  it('classifies text/frame/reference modes', () => {
    expect(mediaMode({})).toBe('text');
    expect(mediaMode({ firstFrameUrl: 'https://x/a.png' })).toBe('frame');
    expect(mediaMode({ lastFrameUrl: 'https://x/b.png' })).toBe('frame');
    expect(mediaMode({ referenceImageUrl: 'https://x/c.png' })).toBe('reference');
    expect(mediaMode({ referenceAudioUrl: 'https://x/a.mp3' })).toBe('reference');
  });

  it('accepts a plain text-to-video request', () => {
    expect(validateMediaCombination({})).toHaveLength(0);
  });

  it('accepts first frame alone and first+last frame together', () => {
    expect(
      validateMediaCombination({ firstFrameUrl: 'https://x/a.png' }),
    ).toHaveLength(0);
    expect(
      validateMediaCombination({
        firstFrameUrl: 'https://x/a.png',
        lastFrameUrl: 'https://x/b.png',
      }),
    ).toHaveLength(0);
  });

  it('rejects a last frame without a first frame', () => {
    const errors = validateMediaCombination({ lastFrameUrl: 'https://x/b.png' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('lastFrameUrl');
  });

  it('rejects mixing frame mode with reference media', () => {
    const errors = validateMediaCombination({
      firstFrameUrl: 'https://x/a.png',
      referenceImageUrl: 'https://x/c.png',
    });
    expect(errors.some((e) => e.field === 'firstFrameUrl')).toBe(true);
  });

  it('rejects reference audio used alone', () => {
    const errors = validateMediaCombination({
      referenceAudioUrl: 'https://x/a.mp3',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('referenceAudioUrl');
  });

  it('accepts reference audio alongside a reference image', () => {
    expect(
      validateMediaCombination({
        referenceImageUrl: 'https://x/c.png',
        referenceAudioUrl: 'https://x/a.mp3',
      }),
    ).toHaveLength(0);
  });
});

describe('conditional ratio behavior', () => {
  it('rejects adaptive for text-to-video', () => {
    expect(validateRatioForMode('adaptive', {})).not.toBeNull();
  });

  it('accepts a concrete ratio for text-to-video', () => {
    expect(validateRatioForMode('16:9', {})).toBeNull();
  });

  it('accepts adaptive for first/last-frame mode', () => {
    expect(
      validateRatioForMode('adaptive', { firstFrameUrl: 'https://x/a.png' }),
    ).toBeNull();
  });

  it('accepts adaptive or concrete for reference mode', () => {
    expect(
      validateRatioForMode('adaptive', { referenceImageUrl: 'https://x/c.png' }),
    ).toBeNull();
    expect(
      validateRatioForMode('16:9', { referenceImageUrl: 'https://x/c.png' }),
    ).toBeNull();
  });
});
