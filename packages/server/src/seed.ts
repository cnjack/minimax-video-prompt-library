/**
 * Sample prompts seeded into an empty database in mock mode so first-time users
 * immediately understand the product. Only runs when the prompt table is empty.
 */

import type { PromptRepository } from './db/repositories/promptRepo.js';
import type { PromptService } from './services/promptService.js';

interface Sample {
  name: string;
  description: string;
  tags: string[];
  status: 'draft' | 'active';
  content: string;
}

const SAMPLES: Sample[] = [
  {
    name: 'Cinematic Product Reveal',
    description:
      'Slow, dramatic reveal of a product in a cinematic setting. Great for hero shots.',
    tags: ['product', 'cinematic', 'hero'],
    status: 'active',
    content:
      'Cinematic product film of {{product}} placed in {{setting}}. ' +
      'Slow dolly-in, volumetric light, shallow depth of field, a {{mood}} color grade, ' +
      'subtle particles drifting through the air, ultra-detailed, photoreal.',
  },
  {
    name: 'Travel Destination Teaser',
    description: 'Vibrant travel teaser highlighting a destination and season.',
    tags: ['travel', 'social', 'teaser'],
    status: 'active',
    content:
      'A sweeping aerial travel film of {{destination}} during {{season}}. ' +
      'Golden-hour lighting, smooth drone movement over landmarks, warm inviting grade, ' +
      'textured clouds, high dynamic range.',
  },
  {
    name: 'Character Intro Shot',
    description: 'A stylized character introduction with a clear action.',
    tags: ['character', 'narrative'],
    status: 'draft',
    content:
      'A stylized character introduction: {{character}} {{action}}. ' +
      'Dynamic camera move, dramatic rim lighting, film grain, cinematic, ' +
      'confident pacing, shallow focus on the subject.',
  },
];

export function seedSamplesIfEmpty(
  prompts: PromptRepository,
  service: PromptService,
): number {
  if (prompts.count() > 0) {
    return 0;
  }
  for (const sample of SAMPLES) {
    service.create(sample);
  }
  return SAMPLES.length;
}
