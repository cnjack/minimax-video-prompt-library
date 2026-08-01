import { describe, expect, it } from 'vitest';
import { buildCreatePayload } from './minimaxPayload.js';
import type { CreateJobInput } from './types.js';

function input(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    renderedPrompt: 'A cat in a hat',
    model: 'MiniMax-Hailuo-2.3',
    durationSeconds: 6,
    resolution: '1080P',
    ...overrides,
  };
}

describe('buildCreatePayload (MiniMax-Hailuo-2.3 flat body)', () => {
  it('builds a flat text-to-video body with no content array and no ratio', () => {
    const payload = buildCreatePayload(input());
    expect(payload).toEqual({
      model: 'MiniMax-Hailuo-2.3',
      prompt: 'A cat in a hat',
      duration: 6,
      resolution: '1080P',
    });
    // The legacy H3 multimodal/ratio contract must NOT be present.
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('ratio');
    expect(payload).not.toHaveProperty('aspect_ratio');
    expect(payload).not.toHaveProperty('first_frame_image');
  });

  it('adds first_frame_image for image-to-video only when a first frame is set', () => {
    const withFrame = buildCreatePayload(
      input({ firstFrameUrl: 'https://e.com/ff.jpeg' }),
    );
    expect(withFrame.first_frame_image).toBe('https://e.com/ff.jpeg');
    // Still flat — no content array / roles.
    expect(withFrame).not.toHaveProperty('content');

    const withoutFrame = buildCreatePayload(input());
    expect(withoutFrame).not.toHaveProperty('first_frame_image');
  });

  it('passes duration and resolution through verbatim', () => {
    const payload = buildCreatePayload(
      input({ durationSeconds: 10, resolution: '768P' }),
    );
    expect(payload.duration).toBe(10);
    expect(payload.resolution).toBe('768P');
  });
});
