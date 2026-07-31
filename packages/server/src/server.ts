/**
 * Server entry point. Boots configuration, opens the database, runs migrations,
 * seeds samples (mock mode), builds the provider + services, serves the built
 * client when present, and starts the in-process poller.
 */

import { createServer } from 'node:http';
import type { AppConfig } from './config.js';
import { assertStartupConfig, loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { PromptRepository } from './db/repositories/promptRepo.js';
import { createProvider } from './providers/registry.js';
import { createAppServices } from './services/container.js';
import { PromptService } from './services/promptService.js';
import { VersionRepository } from './db/repositories/versionRepo.js';
import { JobRepository } from './db/repositories/jobRepo.js';
import { JobPoller } from './poller/poller.js';
import { seedSamplesIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { nowIso } from './util.js';

export interface BootedServer {
  app: ReturnType<typeof createApp>;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function boot(overrideConfig?: AppConfig): Promise<BootedServer> {
  const config = overrideConfig ?? loadConfig();
  assertStartupConfig(config);

  const db = openDatabase(config.dbPath, { ensureDir: true });
  const { applied } = runMigrations(db);
  if (applied.length > 0) {
    console.info(`[db] applied migrations: ${applied.join(', ')}`);
  }

  // Recover orphaned jobs: a queued/running row with no provider task means the
  // process was interrupted before/during submission. Move them to an explicit
  // recoverable failed state so the poller never spins on them forever.
  //
  // Provider exactly-once boundary (unavoidable for this single-instance PoC):
  // if the process died *after* the provider accepted the request but *before*
  // the task id was persisted, the provider may have started a paid generation
  // the local row knows nothing about. Retrying the recovered job therefore
  // creates a new local job (and may create a second provider generation); a
  // durable outbox + provider idempotency would be needed to close this gap.
  const recovered = new JobRepository(db).recoverUnsubmitted(nowIso());
  if (recovered.length > 0) {
    console.info(`[db] recovered ${recovered.length} interrupted job(s) to failed.`);
  }

  if (config.seedSamples) {
    const prompts = new PromptRepository(db);
    const versions = new VersionRepository(db);
    const service = new PromptService(prompts, versions);
    const seeded = seedSamplesIfEmpty(prompts, service);
    if (seeded > 0) {
      console.info(`[seed] inserted ${seeded} sample prompts.`);
    }
  }

  const provider = createProvider(config);
  const services = createAppServices(db, provider, config.providerMode);
  const app = createApp({ config, services });

  const poller = new JobPoller(
    new JobRepository(db),
    provider,
    config,
    (level, message) => console[level](`[poller] ${message}`),
  );
  poller.start();

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(config.port, () => resolve());
  });
  console.info(
    `[server] listening on :${config.port} (mode=${config.providerMode})`,
  );

  const shutdown = async (): Promise<void> => {
    poller.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    try {
      db.close();
    } catch {
      // ignore close errors on shutdown
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }

  return { app, config, close: shutdown };
}

// Run only when invoked directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  boot().catch((error) => {
    console.error('[server] failed to start:', error);
    process.exit(1);
  });
}
