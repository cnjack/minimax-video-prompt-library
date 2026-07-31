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
    expect(payload.aspect_ratio).toBe('16:9');
    expect(payload.resolution).toBe('2K');
    expect(payload.content).toHaveLength(1);
    expect(payload.content[0]).toEqual({ type: 'text', text: 'A cat in a hat' });
  });

  it('adds a single video control block with all provided references', () => {
    const payload = buildCreatePayload(
      input({
        firstFrameUrl: 'https://e.com/ff.png',
        lastFrameUrl: 'https://e.com/lf.png',
        referenceImageUrl: 'https://e.com/ri.png',
        referenceVideoUrl: 'https://e.com/rv.mp4',
        referenceAudioUrl: 'https://e.com/ra.mp3',
      }),
    );
    expect(payload.content).toHaveLength(2);
    const control = payload.content[1];
    expect(control).toEqual({
      type: 'video',
      first_frame_image: { url: 'https://e.com/ff.png' },
      last_frame_image: { url: 'https://e.com/lf.png' },
      reference_image: { url: 'https://e.com/ri.png' },
      reference_video: { url: 'https://e.com/rv.mp4' },
      reference_audio: { url: 'https://e.com/ra.mp3' },
    });
  });

  it('includes only the supplied control keys', () => {
    const blocks = buildContentBlocks(input({ firstFrameUrl: 'https://e.com/ff.png' }));
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: 'video',
      first_frame_image: { url: 'https://e.com/ff.png' },
    });
  });
});
