/**
 * Request validation schemas (zod). The single source of truth for the shape of
 * inbound API requests. Both the server (for enforcement) and the client (for
 * early UI validation) import these.
 */

import { z } from 'zod';
import {
  MINIMAX_DURATIONS,
  MINIMAX_MAX_PROMPT_CHARS,
  MINIMAX_RESOLUTIONS,
  isDurationResolutionCompatible,
  validateDurationResolution,
} from './video-policy.js';
import { VARIABLE_NAME_PATTERN } from './template.js';

/** Accept only http(s) URLs for externally-referenced media. */
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an absolute http(s) URL');

const optionalUrl = z
  .union([httpUrl, z.literal('')])
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const idSchema = z.string().trim().min(1);

const isoTimestamp = z.string();

export const createPromptSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  content: z.string().trim().min(1).max(8000),
  status: z.enum(['draft', 'active']).default('draft'),
});
export type CreatePromptRequest = z.infer<typeof createPromptSchema>;

export const updatePromptSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
});
export type UpdatePromptRequest = z.infer<typeof updatePromptSchema>;

export const duplicatePromptSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});
export type DuplicatePromptRequest = z.infer<typeof duplicatePromptSchema>;

export const createVersionSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  /** Optional variables override; normally derived from content. */
  variables: z
    .array(z.string().regex(VARIABLE_NAME_PATTERN))
    .optional(),
});
export type CreateVersionRequest = z.infer<typeof createVersionSchema>;

export const renderPreviewSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  values: z.record(z.string(), z.string()).default({}),
});
export type RenderPreviewRequest = z.infer<typeof renderPreviewSchema>;

/**
 * Fields that MiniMax-Hailuo-2.3 does NOT support. They are declared (as plain
 * optional strings) only so the schema can VISIBLY REJECT a non-empty value
 * with a clear message — silently dropping them would hide an unsupported
 * request. The inferred request type marks them optional/deprecated.
 */
const UNSUPPORTED_MEDIA_FIELDS = {
  aspectRatio: 'Aspect ratio is not supported by MiniMax-Hailuo-2.3.',
  lastFrameUrl: 'Last-frame media is not supported by MiniMax-Hailuo-2.3.',
  referenceImageUrl:
    'Reference-image media is not supported by MiniMax-Hailuo-2.3.',
  referenceVideoUrl:
    'Reference-video media is not supported by MiniMax-Hailuo-2.3.',
  referenceAudioUrl:
    'Reference-audio media is not supported by MiniMax-Hailuo-2.3.',
} as const;

export const createGenerationSchema = z
  .object({
    promptVersionId: idSchema,
    values: z.record(z.string(), z.string()).default({}),
    /**
     * Optional fully-rendered prompt override. When a non-empty string is
     * supplied (e.g. by the composer after inserting camera-motion cues), the
     * server uses it verbatim as the `prompt` instead of rendering the
     * immutable prompt version with `values`. It is still subject to the
     * MiniMax rendered-character limit. Omit/leave blank to render from the
     * version.
     */
    prompt: z.string().trim().max(MINIMAX_MAX_PROMPT_CHARS).optional(),
    durationSeconds: z
      .number()
      .int()
      .refine((v) => (MINIMAX_DURATIONS as readonly number[]).includes(v), {
        message: 'durationSeconds must be 6 or 10.',
      }),
    resolution: z.enum(MINIMAX_RESOLUTIONS),
    /** First-frame image-to-video (MiniMax-Hailuo-2.3 `first_frame_image`). */
    firstFrameUrl: optionalUrl,
    // Deprecated/unsupported fields — visibly rejected if supplied (see above).
    aspectRatio: z.string().optional(),
    lastFrameUrl: z.string().optional(),
    referenceImageUrl: z.string().optional(),
    referenceVideoUrl: z.string().optional(),
    referenceAudioUrl: z.string().optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    /** Honored only in mock mode; ignored by the real adapter. */
    mockScenario: z
      .enum(['success', 'failure', 'expired', 'provider_error', 'slow'])
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Visibly disable unsupported options: a non-empty value is a 400.
    for (const [field, message] of Object.entries(UNSUPPORTED_MEDIA_FIELDS)) {
      const value = (data as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          path: [field],
        });
      }
    }
    // Duration/resolution cross-field rule: 10s only at 768P.
    if (!isDurationResolutionCompatible(data.durationSeconds, data.resolution)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          validateDurationResolution(data.durationSeconds, data.resolution)
            ?.message ??
          'The chosen duration/resolution combination is not supported.',
        path: ['resolution'],
      });
    }
  });
export type CreateGenerationRequest = z.infer<typeof createGenerationSchema>;

/**
 * Maximum length of the rendered prompt sent to MiniMax. Re-exported here so
 * callers that only depend on the schema module can enforce it server-side
 * after variable substitution (the schema cannot, because rendering happens
 * after validation).
 */
export const MAX_RENDERED_PROMPT_CHARS = MINIMAX_MAX_PROMPT_CHARS;

export const listJobsQuerySchema = z.object({
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'expired'])
    .optional(),
  promptId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const listPromptsQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  tag: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListPromptsQuery = z.infer<typeof listPromptsQuerySchema>;

/** Re-export so consumers do not depend on zod directly. */
export { isoTimestamp };
