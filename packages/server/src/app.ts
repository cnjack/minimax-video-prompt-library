/**
 * Express application factory. Pure (does not listen) so it can be tested with
 * supertest. Mounts CORS, JSON parsing, request ids, a redacted request log,
 * the API routers, optional static client serving, and the error middleware.
 */

import cors from 'cors';
import express, { type Express } from 'express';
import type { AppConfig } from './config.js';
import type { AppServices } from './services/container.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFound } from './middleware/error.js';
import { asyncHandler } from './middleware/asyncHandler.js';
import { createHealthRouter } from './routes/health.js';
import { createPromptsRouter } from './routes/prompts.js';
import { createVersionsRouter } from './routes/versions.js';
import { createRenderRouter } from './routes/render.js';
import { createJobsRouter } from './routes/jobs.js';
import { createScenariosRouter } from './routes/scenarios.js';

export interface AppDeps {
  config: AppConfig;
  services: AppServices;
}

export function createApp(deps: AppDeps): Express {
  const { config, services } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use(requestLog);

  app.use('/api', createHealthRouter(config));
  app.use('/api/prompts/:promptId/versions', createVersionsRouter(services));
  app.use('/api/prompts', createPromptsRouter(services));
  app.use('/api', createRenderRouter(services));
  app.use('/api/generations', createJobsRouter(services));
  if (services.mockProvider) {
    app.use('/api/debug/mock', createScenariosRouter(services));
  }

  app.use('/api', notFound);

  if (config.clientDist) {
    app.use(express.static(config.clientDist));
    // SPA fallback: serve index.html for any non-API GET route.
    app.get(
      '*',
      asyncHandler(async (_req, res) => {
        res.sendFile(config.clientDist as string + '/index.html');
      }),
    );
  } else {
    app.use(notFound);
  }

  app.use(errorHandler);
  return app;
}

/** Minimal request log: method, path, status, duration, request id. No bodies. */
function requestLog(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const id = (res.locals.requestId as string | undefined) ?? '-';
    console.info(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms rid=${id}`,
    );
  });
  next();
}
