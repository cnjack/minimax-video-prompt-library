import { describe, expect, it } from 'vitest';
import {
  createGenerationSchema,
  createPromptSchema,
} from '../schemas.js';
import { H3_ASPECT_RATIOS } from '../h3-policy.js';

describe('createGenerationSchema validation', () => {
  const base = {
    promptVersionId: 'v1',
    values: {},
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '2K',
  };

  it('accepts a minimal valid request', () => {
    expect(() => createGenerationSchema.parse(base)).not.toThrow();
  });

  it('accepts duration boundaries 4 and 15', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 4 }),
    ).not.toThrow();
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 15 }),
    ).not.toThrow();
  });

  it('rejects out-of-range durations', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 3 }),
    ).toThrow();
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 16 }),
    ).toThrow();
  });

  it.each(H3_ASPECT_RATIOS)('accepts supported aspect ratio %s', (ratio) => {
    expect(() =>
      createGenerationSchema.parse({ ...base, aspectRatio: ratio }),
    ).not.toThrow();
  });

  it('rejects an unsupported aspect ratio', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, aspectRatio: '2.35:1' }),
    ).toThrow();
  });

  it('rejects an unsupported resolution', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, resolution: '4K' }),
    ).toThrow();
  });

  it('accepts http(s) reference URLs', () => {
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        firstFrameUrl: 'https://example.com/a.png',
        referenceVideoUrl: 'http://example.com/b.mp4',
      }),
    ).not.toThrow();
  });

  it('rejects non-http(s) URLs', () => {
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        firstFrameUrl: 'file:///etc/passwd',
      }),
    ).toThrow();
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        referenceImageUrl: 'ftp://example.com/x.png',
      }),
    ).toThrow();
  });

  it('requires a prompt version id', () => {
    expect(() => createGenerationSchema.parse({ ...base, promptVersionId: '' })).toThrow();
  });
});

describe('createPromptSchema', () => {
  it('defaults status and tags', () => {
    const parsed = createPromptSchema.parse({ name: 'x', content: 'hi' });
    expect(parsed.status).toBe('draft');
    expect(parsed.tags).toEqual([]);
    expect(parsed.description).toBe('');
  });

  it('rejects empty content', () => {
    expect(() => createPromptSchema.parse({ name: 'x', content: '   ' })).toThrow();
  });
});
