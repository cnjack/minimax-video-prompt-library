/** Generation-job REST resources: create, list, detail, retry. */

import { Router } from 'express';
import { createGenerationSchema, listJobsQuerySchema } from '@h3/shared';
import type { AppServices } from '../services/container.js';
import { asyncHandler, parseBody, routeParam } from '../middleware/asyncHandler.js';
import { IDEMPOTENCY_KEY_HEADER, readIdempotencyKey } from '../middleware/idempotency.js';

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
      // Retry idempotency is driven by an explicit per-attempt Idempotency-Key
      // header (one token per user click). The same token reused while the HTTP
      // outcome is unknown reuses the retried job (200); a fresh token creates a
      // new job (201). This keeps transport retries safe without permanently
      // mapping every retry of a source to the first retried job.
      const idempotencyKey = readIdempotencyKey(req.header(IDEMPOTENCY_KEY_HEADER));
      const result = await services.generations.retry(routeParam(req, 'id'), idempotencyKey);
      res.status(result.reused ? 200 : 201).json(result);
    }),
  );

  router.post(
    '/:id/resume',
    asyncHandler(async (req, res) => {
      // Resume tracking-exhausted jobs: re-enable polling of the SAME stored
      // provider task id with NO paid provider create. It takes no idempotency
      // key (it is not a paid create) and is idempotent/concurrency-safe by
      // construction (the repository transition is a single atomic CAS).
      const job = services.generations.resume(routeParam(req, 'id'));
      res.status(200).json(job);
    }),
  );

  return router;
}
