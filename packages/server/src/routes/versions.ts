/** Version REST resources: create a version, restore a prior version. */

import { Router } from 'express';
import { createVersionSchema, parseTemplate } from '@h3/shared';
import type { AppServices } from '../services/container.js';
import { asyncHandler, parseBody, routeParam } from '../middleware/asyncHandler.js';

export function createVersionsRouter(services: AppServices): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = parseBody(createVersionSchema, req.body);
      parseTemplate(body.content);
      const version = services.prompts.createVersion(routeParam(req, 'promptId'), body.content);
      res.status(201).json(version);
    }),
  );

  router.post(
    '/:versionId/restore',
    asyncHandler(async (req, res) => {
      const version = services.prompts.restoreVersion(
        routeParam(req, 'promptId'),
        routeParam(req, 'versionId'),
      );
      res.status(201).json(version);
    }),
  );

  return router;
}
