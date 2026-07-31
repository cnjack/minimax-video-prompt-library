/**
 * Request validation schemas (zod). The single source of truth for the shape of
 * inbound API requests. Both the server (for enforcement) and the client (for
 * early UI validation) import these.
 */

import { z } from 'zod';
import {
  H3_ASPECT_RATIOS,
  H3_MAX_DURATION_SECONDS,
  H3_MAX_PROMPT_CHARS,
  H3_MIN_DURATION_SECONDS,
  H3_RESOLUTIONS,
  validateMediaCombination,
  validateRatioForMode,
} from './h3-policy.js';
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

const optionalUrl = z.union([httpUrl, z.literal('')]).optional().transform((v) => (v && v.length > 0 ? v : undefined));

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

export const createGenerationSchema = z
  .object({
    promptVersionId: idSchema,
    values: z.record(z.string(), z.string()).default({}),
    durationSeconds: z
      .number()
      .int()
      .min(H3_MIN_DURATION_SECONDS)
      .max(H3_MAX_DURATION_SECONDS),
    aspectRatio: z.enum(H3_ASPECT_RATIOS),
    resolution: z.enum(H3_RESOLUTIONS),
    firstFrameUrl: optionalUrl,
    lastFrameUrl: optionalUrl,
    referenceImageUrl: optionalUrl,
    referenceVideoUrl: optionalUrl,
    referenceAudioUrl: optionalUrl,
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    /** Honored only in mock mode; ignored by the real adapter. */
    mockScenario: z
      .enum(['success', 'failure', 'expired', 'provider_error', 'slow'])
      .optional(),
  })
  .superRefine((data, ctx) => {
    // H3 media cross-field rules (shared with the UI via the policy module).
    const mediaErrors = validateMediaCombination({
      firstFrameUrl: data.firstFrameUrl,
      lastFrameUrl: data.lastFrameUrl,
      referenceImageUrl: data.referenceImageUrl,
      referenceVideoUrl: data.referenceVideoUrl,
      referenceAudioUrl: data.referenceAudioUrl,
    });
    for (const err of mediaErrors) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err.message,
        path: [err.field],
      });
    }
    // Conditional ratio behavior: text-to-video cannot use "adaptive".
    const ratioError = validateRatioForMode(data.aspectRatio, {
      firstFrameUrl: data.firstFrameUrl,
      lastFrameUrl: data.lastFrameUrl,
      referenceImageUrl: data.referenceImageUrl,
      referenceVideoUrl: data.referenceVideoUrl,
      referenceAudioUrl: data.referenceAudioUrl,
    });
    if (ratioError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: ratioError.message,
        path: ['aspectRatio'],
      });
    }
  });
export type CreateGenerationRequest = z.infer<typeof createGenerationSchema>;

/**
 * Maximum length of the rendered prompt text item sent to H3. Re-exported here
 * so callers that only depend on the schema module can enforce it server-side
 * after variable substitution (the schema cannot, because rendering happens
 * after validation).
 */
export const MAX_RENDERED_PROMPT_CHARS = H3_MAX_PROMPT_CHARS;

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
