import { describe, expect, it } from 'vitest';
import { buildContentBlocks, buildCreatePayload } from './minimaxPayload.js';
import type { CreateJobInput } from './types.js';

function input(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    renderedPrompt: 'A cat in a hat',
    model: 'MiniMax-H3',
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '2K',
    ...overrides,
  };
}

describe('buildCreatePayload', () => {
  it('builds a text-only content array when no references are set', () => {
    const payload = buildCreatePayload(input());
    expect(payload.model).toBe('MiniMax-H3');
    expect(payload.duration).toBe(6);
    // Official field is top-level `ratio`, NOT `aspect_ratio`.
    expect(payload).toHaveProperty('ratio', '16:9');
    expect(payload).not.toHaveProperty('aspect_ratio');
    expect(payload.resolution).toBe('2K');
    expect(payload.content).toHaveLength(1);
    expect(payload.content[0]).toEqual({ type: 'text', text: 'A cat in a hat' });
  });

  it('uses adaptive ratio verbatim when provided', () => {
    const payload = buildCreatePayload(input({ aspectRatio: 'adaptive' }));
    expect(payload.ratio).toBe('adaptive');
  });

  it('emits one independent media item per provided reference, each with a role', () => {
    const payload = buildCreatePayload(
      input({
        firstFrameUrl: 'https://e.com/ff.png',
        lastFrameUrl: 'https://e.com/lf.png',
        referenceImageUrl: 'https://e.com/ri.png',
        referenceVideoUrl: 'https://e.com/rv.mp4',
        referenceAudioUrl: 'https://e.com/ra.mp3',
      }),
    );
    // text + 5 media items
    expect(payload.content).toHaveLength(6);
    expect(payload.content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'https://e.com/ff.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://e.com/lf.png' }, role: 'last_frame' },
      { type: 'image_url', image_url: { url: 'https://e.com/ri.png' }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: 'https://e.com/rv.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'https://e.com/ra.mp3' }, role: 'reference_audio' },
    ]);
  });

  it('includes only the supplied media items', () => {
    const blocks = buildContentBlocks(input({ firstFrameUrl: 'https://e.com/ff.png' }));
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://e.com/ff.png' },
      role: 'first_frame',
    });
  });

  it('never emits a legacy video-control block', () => {
    const payload = buildCreatePayload(
      input({ firstFrameUrl: 'https://e.com/ff.png' }),
    );
    // Every non-text item is an independent media block carrying a `role`.
    expect(
      payload.content.every((b) => b.type === 'text' || 'role' in b),
    ).toBe(true);
  });
});
