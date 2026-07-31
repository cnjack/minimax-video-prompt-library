/**
 * Pure construction of the MiniMax H3 V2 request payload.
 *
 * The official endpoint is `POST {base}/v2/video_generation` with model
 * `MiniMax-H3`. Per the PRD, the body uses a multimodal `content` array: a text
 * block plus an optional video-control block carrying first/last frame and
 * reference media URLs. Keeping this pure lets the mapping be unit-tested
 * without touching the network.
 */

import type { CreateJobInput } from './types.js';

export interface ContentTextBlock {
  type: 'text';
  text: string;
}

export interface ContentVideoBlock {
  type: 'video';
  first_frame_image?: { url: string };
  last_frame_image?: { url: string };
  reference_image?: { url: string };
  reference_video?: { url: string };
  reference_audio?: { url: string };
}

export type ContentBlock = ContentTextBlock | ContentVideoBlock;

export interface MinimaxCreatePayload {
  model: string;
  content: ContentBlock[];
  duration: number;
  aspect_ratio: string;
  resolution: string;
}

/** Build the create-payload content array from generation inputs. */
export function buildContentBlocks(input: CreateJobInput): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: input.renderedPrompt }];

  const controlBlock: ContentVideoBlock = { type: 'video' };
  if (input.firstFrameUrl) controlBlock.first_frame_image = { url: input.firstFrameUrl };
  if (input.lastFrameUrl) controlBlock.last_frame_image = { url: input.lastFrameUrl };
  if (input.referenceImageUrl) controlBlock.reference_image = { url: input.referenceImageUrl };
  if (input.referenceVideoUrl) controlBlock.reference_video = { url: input.referenceVideoUrl };
  if (input.referenceAudioUrl) controlBlock.reference_audio = { url: input.referenceAudioUrl };

  const hasControl = Object.keys(controlBlock).length > 1; // more than just `type`
  if (hasControl) {
    blocks.push(controlBlock);
  }
  return blocks;
}

export function buildCreatePayload(input: CreateJobInput): MinimaxCreatePayload {
  return {
    model: input.model,
    content: buildContentBlocks(input),
    duration: input.durationSeconds,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  };
}
