/** Prompt REST resources: list, create, detail, update, duplicate, archive. */

import { Router } from 'express';
import {
  createPromptSchema,
  duplicatePromptSchema,
  listPromptsQuerySchema,
  parseTemplate,
  updatePromptSchema,
} from '@h3/shared';
import type { AppServices } from '../services/container.js';
import { asyncHandler, parseBody, routeParam } from '../middleware/asyncHandler.js';

export function createPromptsRouter(services: AppServices): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = listPromptsQuerySchema.parse({
        q: req.query.q,
        status: req.query.status,
        tag: req.query.tag,
        limit: req.query.limit,
      });
      const items = services.prompts.list(query);
      res.json({ items, total: items.length });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = parseBody(createPromptSchema, req.body);
      // Reject templates with invalid placeholders at creation time.
      parseTemplate(body.content);
      const detail = services.prompts.create(body);
      res.status(201).json(detail);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const detail = services.prompts.getDetail(routeParam(req, 'id'));
      res.json(detail);
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const body = parseBody(updatePromptSchema, req.body);
      const prompt = services.prompts.update(routeParam(req, 'id'), body);
      res.json(prompt);
    }),
  );

  router.post(
    '/:id/duplicate',
    asyncHandler(async (req, res) => {
      const body = parseBody(duplicatePromptSchema, req.body);
      const detail = services.prompts.duplicate(routeParam(req, 'id'), body.name);
      res.status(201).json(detail);
    }),
  );

  // Story 11: archive rather than destroy. DELETE archives the prompt.
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const prompt = services.prompts.update(routeParam(req, 'id'), {
        status: 'archived',
      });
      res.json(prompt);
    }),
  );

  return router;
}
