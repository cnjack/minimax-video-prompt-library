/**
 * Server entry point. Boots configuration, opens the database, runs migrations,
 * seeds samples (mock mode), builds the provider + services, serves the built
 * client when present, and starts the in-process poller.
 *
 * Lifecycle correctness:
 *  - `server.listen` errors are caught (e.g. EADDRINUSE); on a listen failure
 *    the database is closed and boot rejects.
 *  - the poller is started ONLY after listening succeeds, so a failed bind never
 *    leaves a poller ticking against a closed DB.
 *  - SIGINT/SIGTERM handlers are registered ONLY in the direct-execution path
 *    (when this module is `import.meta.main`), never when boot() is imported by
 *    tests — so tests never leave process signal handlers behind.
 *  - shutdown failures (server.close / db.close) propagate; the direct-execution
 *    wrapper exits NON-ZERO on them.
 */

import { createServer, type Server } from 'node:http';
import type { AppConfig } from './config.js';
import { assertStartupConfig, loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import type { DB } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { PromptRepository } from './db/repositories/promptRepo.js';
import { createProvider } from './providers/registry.js';
import type { VideoProvider } from './providers/types.js';
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
  server: Server;
  close: () => Promise<void>;
}

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
type PollerLike = { start(): void; stop(): void };

export interface BootDeps {
  /** Inject the database opener (tests observe close-on-failure). */
  openDatabase?: (dbPath: string, options?: { ensureDir?: boolean }) => DB;
  /** Inject the poller factory (tests observe start-after-listen). */
  createPoller?: (
    jobs: JobRepository,
    provider: VideoProvider,
    config: AppConfig,
    log: LogFn,
  ) => PollerLike;
}

export async function boot(
  overrideConfig?: AppConfig,
  deps: BootDeps = {},
): Promise<BootedServer> {
  const config = overrideConfig ?? loadConfig();
  assertStartupConfig(config);

  const openDb = deps.openDatabase ?? openDatabase;
  const db = openDb(config.dbPath, { ensureDir: true });
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
    const service = new PromptService(prompts, versions, db);
    const seeded = seedSamplesIfEmpty(prompts, service);
    if (seeded > 0) {
      console.info(`[seed] inserted ${seeded} sample prompts.`);
    }
  }

  const provider = createProvider(config);
  const services = createAppServices(db, provider, config.providerMode);
  const app = createApp({ config, services });

  const server = createServer(app);

  // Bind first. A bind failure (e.g. EADDRINUSE) must close the DB and reject so
  // the caller (direct-execution wrapper) can exit non-zero.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      try {
        db.close();
      } catch {
        // Best-effort cleanup on a failed bind.
      }
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port);
  });

  // Listening succeeded: NOW it is safe to start the poller against the live DB.
  const pollerFactory =
    deps.createPoller ??
    ((jobs, prov, cfg, log) => new JobPoller(jobs, prov, cfg, log));
  const poller = pollerFactory(
    new JobRepository(db),
    provider,
    config,
    (level, message) => console[level](`[poller] ${message}`),
  );
  poller.start();

  console.info(
    `[server] listening on :${config.port} (mode=${config.providerMode})`,
  );

  const shutdown = async (): Promise<void> => {
    poller.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // A db.close failure propagates so the direct-execution wrapper can exit
    // non-zero (shutdown failures must not be swallowed).
    db.close();
  };

  return { app, config, server, close: shutdown };
}

// Run only when invoked directly (not when imported by tests). Signal handlers
// live HERE, in the direct-execution path only, so imported boot() calls never
// register process handlers.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  boot()
    .then((booted) => {
      let shuttingDown = false;
      const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        void booted
          .close()
          .then(() => {
            console.info(`[server] received ${signal}; shutdown complete.`);
            process.exit(0);
          })
          .catch((error) => {
            console.error('[server] shutdown failed:', error);
            process.exit(1);
          });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error('[server] failed to start:', error);
      process.exit(1);
    });
}
