/**
 * Pure construction of the MiniMax-Hailuo-2.3 video-generation request payload.
 *
 * Official contract (`POST {base}/v1/video_generation`, model
 * `MiniMax-Hailuo-2.3`): the body is FLAT. There is no `content[]` array, no
 * `role`, and no `ratio`/`aspect_ratio`.
 *  - Text-to-video: `{ model, prompt, duration, resolution }`.
 *  - Image-to-video: the same plus `first_frame_image` (a single image URL).
 *
 * Keeping this pure lets the mapping be unit-tested without touching the
 * network. Cross-field rules and the rendered-prompt length limit are enforced
 * before the request reaches this builder.
 */

import type { CreateJobInput } from './types.js';

export interface MinimaxCreatePayload {
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  /** Present only for image-to-video (a first-frame image URL). */
  first_frame_image?: string;
}

export function buildCreatePayload(input: CreateJobInput): MinimaxCreatePayload {
  const payload: MinimaxCreatePayload = {
    model: input.model,
    prompt: input.renderedPrompt,
    duration: input.durationSeconds,
    resolution: input.resolution,
  };
  if (input.firstFrameUrl) {
    payload.first_frame_image = input.firstFrameUrl;
  }
  return payload;
}
