/**
 * Pure construction of the MiniMax H3 V2 request payload.
 *
 * Official contract (`POST {base}/v2/video_generation`, model `MiniMax-H3`):
 *  - `content[]` carries one nonempty text item plus independent media items,
 *    each tagged with a `role`:
 *      { type: 'text', text }
 *      { type: 'image_url', image_url: { url }, role: 'first_frame' | 'last_frame' | 'reference_image' }
 *      { type: 'video_url', video_url: { url }, role: 'reference_video' }
 *      { type: 'audio_url', audio_url: { url }, role: 'reference_audio' }
 *  - the top-level field is `ratio` (NOT `aspect_ratio`); the local domain
 *    stores the selected value as `aspectRatio` and this builder maps it over.
 *
 * Keeping this pure lets the mapping be unit-tested without touching the
 * network. Cross-field media rules and the rendered-prompt length limit are
 * enforced before the request reaches this builder.
 */

import type { CreateJobInput } from './types.js';

export type MediaRole =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio';

export interface ContentTextBlock {
  type: 'text';
  text: string;
}

export interface ContentImageBlock {
  type: 'image_url';
  image_url: { url: string };
  role: 'first_frame' | 'last_frame' | 'reference_image';
}

export interface ContentVideoBlock {
  type: 'video_url';
  video_url: { url: string };
  role: 'reference_video';
}

export interface ContentAudioBlock {
  type: 'audio_url';
  audio_url: { url: string };
  role: 'reference_audio';
}

export type ContentMediaBlock =
  | ContentImageBlock
  | ContentVideoBlock
  | ContentAudioBlock;

export type ContentBlock = ContentTextBlock | ContentMediaBlock;

export interface MinimaxCreatePayload {
  model: string;
  content: ContentBlock[];
  ratio: string;
  duration: number;
  resolution: string;
}

/** Build the create-payload content array from generation inputs. */
export function buildContentBlocks(input: CreateJobInput): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: input.renderedPrompt }];

  if (input.firstFrameUrl) {
    blocks.push({
      type: 'image_url',
      image_url: { url: input.firstFrameUrl },
      role: 'first_frame',
    });
  }
  if (input.lastFrameUrl) {
    blocks.push({
      type: 'image_url',
      image_url: { url: input.lastFrameUrl },
      role: 'last_frame',
    });
  }
  if (input.referenceImageUrl) {
    blocks.push({
      type: 'image_url',
      image_url: { url: input.referenceImageUrl },
      role: 'reference_image',
    });
  }
  if (input.referenceVideoUrl) {
    blocks.push({
      type: 'video_url',
      video_url: { url: input.referenceVideoUrl },
      role: 'reference_video',
    });
  }
  if (input.referenceAudioUrl) {
    blocks.push({
      type: 'audio_url',
      audio_url: { url: input.referenceAudioUrl },
      role: 'reference_audio',
    });
  }

  return blocks;
}

export function buildCreatePayload(input: CreateJobInput): MinimaxCreatePayload {
  return {
    model: input.model,
    content: buildContentBlocks(input),
    // Official H3 V2 field is `ratio`; the local domain stores it as aspectRatio.
    ratio: input.aspectRatio,
    duration: input.durationSeconds,
    resolution: input.resolution,
  };
}
