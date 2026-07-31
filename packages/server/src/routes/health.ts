/** Health REST resource. */

import { Router } from 'express';
import type { AppConfig } from '../config.js';
import { buildHealth } from '../health.js';

export function createHealthRouter(config: AppConfig): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json(buildHealth(config));
  });
  router.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });
  return router;
}
