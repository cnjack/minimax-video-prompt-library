import { describe, expect, it } from 'vitest';
import { createGenerationSchema, createPromptSchema } from '../schemas.js';
import { MINIMAX_MAX_PROMPT_CHARS } from '../video-policy.js';

describe('createGenerationSchema validation', () => {
  const base = {
    promptVersionId: 'v1',
    values: {},
    durationSeconds: 6,
    resolution: '768P',
  };

  it('accepts a minimal valid request', () => {
    expect(() => createGenerationSchema.parse(base)).not.toThrow();
  });

  it('accepts both supported durations', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 6 }),
    ).not.toThrow();
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        durationSeconds: 10,
        resolution: '768P',
      }),
    ).not.toThrow();
  });

  it('rejects durations outside the supported set (no arbitrary 4–15s)', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 4 }),
    ).toThrow();
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 5 }),
    ).toThrow();
    expect(() =>
      createGenerationSchema.parse({ ...base, durationSeconds: 15 }),
    ).toThrow();
  });

  it.each(['768P', '1080P'] as const)('accepts resolution %s', (resolution) => {
    expect(() =>
      createGenerationSchema.parse({ ...base, resolution }),
    ).not.toThrow();
  });

  it('rejects an unsupported resolution (no legacy 2K)', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, resolution: '2K' }),
    ).toThrow();
    expect(() =>
      createGenerationSchema.parse({ ...base, resolution: '4K' }),
    ).toThrow();
  });

  it('accepts an http(s) first-frame image URL', () => {
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        firstFrameUrl: 'https://example.com/a.png',
      }),
    ).not.toThrow();
  });

  it('rejects a non-http(s) first-frame URL', () => {
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        firstFrameUrl: 'file:///etc/passwd',
      }),
    ).toThrow();
  });

  it('requires a prompt version id', () => {
    expect(() => createGenerationSchema.parse({ ...base, promptVersionId: '' })).toThrow();
  });
});

describe('createGenerationSchema: 10s only at 768P', () => {
  const base = {
    promptVersionId: 'v1',
    values: {},
    durationSeconds: 10,
    resolution: '768P' as const,
  };

  it('accepts 10s at 768P', () => {
    expect(() => createGenerationSchema.parse(base)).not.toThrow();
  });

  it('rejects 10s at 1080P with a validation error', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, resolution: '1080P' }),
    ).toThrow();
  });
});

describe('createGenerationSchema: unsupported options are visibly disabled', () => {
  const base = {
    promptVersionId: 'v1',
    values: {},
    durationSeconds: 6,
    resolution: '768P' as const,
  };

  it.each([
    ['aspectRatio', '16:9'],
    ['lastFrameUrl', 'https://example.com/b.png'],
    ['referenceImageUrl', 'https://example.com/c.png'],
    ['referenceVideoUrl', 'https://example.com/d.mp4'],
    ['referenceAudioUrl', 'https://example.com/e.mp3'],
  ] as const)('rejects a supplied %s', (field, value) => {
    expect(() =>
      createGenerationSchema.parse({ ...base, [field]: value }),
    ).toThrow();
  });

  it('does not reject an empty/absent unsupported field', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, aspectRatio: '' }),
    ).not.toThrow();
  });
});

describe('createGenerationSchema prompt override limit', () => {
  const base = {
    promptVersionId: 'v1',
    values: {},
    durationSeconds: 6,
    resolution: '768P' as const,
  };

  it('accepts an optional rendered-prompt override and caps it at the limit', () => {
    expect(() =>
      createGenerationSchema.parse({ ...base, prompt: 'a car, pan left' }),
    ).not.toThrow();
    const at = createGenerationSchema.parse({
      ...base,
      prompt: 'x'.repeat(MINIMAX_MAX_PROMPT_CHARS),
    });
    expect(at.prompt).toHaveLength(MINIMAX_MAX_PROMPT_CHARS);
  });

  it('rejects a prompt over the 2000-character limit', () => {
    expect(() =>
      createGenerationSchema.parse({
        ...base,
        prompt: 'x'.repeat(MINIMAX_MAX_PROMPT_CHARS + 1),
      }),
    ).toThrow();
  });

  it('blank-trims the override to empty (treated as absent by the service)', () => {
    expect(createGenerationSchema.parse({ ...base, prompt: '   ' }).prompt).toBe(
      '',
    );
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
