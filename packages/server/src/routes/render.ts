/** Render-preview REST resource used by the editor before submission. */

import { Router } from 'express';
import { renderPreviewSchema } from '@h3/shared';
import type { AppServices } from '../services/container.js';
import { asyncHandler, parseBody } from '../middleware/asyncHandler.js';

export function createRenderRouter(services: AppServices): Router {
  const router = Router();

  router.post(
    '/render-preview',
    asyncHandler(async (req, res) => {
      const body = parseBody(renderPreviewSchema, req.body);
      const result = services.prompts.preview(body.content, body.values);
      res.json(result);
    }),
  );

  return router;
}
