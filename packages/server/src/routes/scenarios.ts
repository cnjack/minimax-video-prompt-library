/** Mock-only scenario control. Mounted only when the mock provider is active. */

import { Router } from 'express';
import { z } from 'zod';
import type { AppServices } from '../services/container.js';
import { asyncHandler, parseBody } from '../middleware/asyncHandler.js';
import { ApiError } from '../errors.js';
import { ErrorCode } from '@h3/shared';

const scenarioSchema = z.object({
  scenario: z.enum(['success', 'failure', 'expired', 'provider_error', 'slow']),
});

export function createScenariosRouter(services: AppServices): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const mock = services.mockProvider;
    if (!mock) {
      throw new ApiError(
        ErrorCode.NOT_FOUND,
        'Scenario control is only available in mock mode.',
      );
    }
    res.json({ scenario: mock.getDefaultScenario(), mode: services.providerName });
  });

  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const mock = services.mockProvider;
      if (!mock) {
        throw new ApiError(
          ErrorCode.NOT_FOUND,
          'Scenario control is only available in mock mode.',
        );
      }
      const body = parseBody(scenarioSchema, req.body);
      mock.setDefaultScenario(body.scenario);
      res.json({ scenario: mock.getDefaultScenario(), mode: services.providerName });
    }),
  );

  return router;
}
