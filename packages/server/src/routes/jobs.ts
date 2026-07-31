/** Generation-job REST resources: create, list, detail, retry. */

import { Router } from 'express';
import { createGenerationSchema, listJobsQuerySchema } from '@h3/shared';
import type { AppServices } from '../services/container.js';
import { asyncHandler, parseBody, routeParam } from '../middleware/asyncHandler.js';

export function createJobsRouter(services: AppServices): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = listJobsQuerySchema.parse({
        status: req.query.status,
        promptId: req.query.promptId,
        limit: req.query.limit,
      });
      const items = services.generations.list(query);
      res.json({ items, total: items.length });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = parseBody(createGenerationSchema, req.body);
      const result = await services.generations.create(body);
      res.status(result.reused ? 200 : 201).json(result);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const job = services.generations.getById(routeParam(req, 'id'));
      res.json(job);
    }),
  );

  router.post(
    '/:id/retry',
    asyncHandler(async (req, res) => {
      // Idempotent: a network retry reuses the existing retried job (derived
      // `retry:<id>` key) and returns 200; the first attempt creates (201).
      const result = await services.generations.retry(routeParam(req, 'id'));
      res.status(result.reused ? 200 : 201).json(result);
    }),
  );

  return router;
}
