/**
 * Schema migrations. Ordered, idempotent, run on startup and via the documented
 * `pnpm migrate` command. A `schema_migrations` table tracks applied versions.
 */

import type { DB } from './client.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS prompts (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        tags               TEXT NOT NULL DEFAULT '[]',
        status             TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','active','archived')),
        current_version_id TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        archived_at        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_prompts_status ON prompts(status);
      CREATE INDEX IF NOT EXISTS idx_prompts_name ON prompts(name);

      CREATE TABLE IF NOT EXISTS prompt_versions (
        id             TEXT PRIMARY KEY,
        prompt_id      TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        content        TEXT NOT NULL,
        variables      TEXT NOT NULL DEFAULT '[]',
        created_at     TEXT NOT NULL,
        UNIQUE(prompt_id, version_number)
      );

      CREATE INDEX IF NOT EXISTS idx_versions_prompt ON prompt_versions(prompt_id);

      CREATE TABLE IF NOT EXISTS generation_jobs (
        id                       TEXT PRIMARY KEY,
        prompt_id                TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        prompt_version_id        TEXT NOT NULL REFERENCES prompt_versions(id),
        rendered_prompt          TEXT NOT NULL,
        model                    TEXT NOT NULL,
        duration_seconds         INTEGER NOT NULL,
        aspect_ratio             TEXT NOT NULL,
        resolution               TEXT NOT NULL,
        first_frame_url          TEXT,
        last_frame_url           TEXT,
        reference_image_url      TEXT,
        reference_video_url      TEXT,
        reference_audio_url      TEXT,
        status                   TEXT NOT NULL DEFAULT 'queued'
                                   CHECK (status IN
                                     ('queued','running','succeeded','failed','expired')),
        provider                 TEXT NOT NULL,
        provider_task_id         TEXT,
        result_url               TEXT,
        error_code               TEXT,
        error_message            TEXT,
        idempotency_key          TEXT NOT NULL UNIQUE,
        idempotency_payload_hash TEXT NOT NULL,
        parameters               TEXT NOT NULL DEFAULT '{}',
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        completed_at             TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_prompt ON generation_jobs(prompt_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON generation_jobs(created_at);
    `,
  },
  {
    version: 2,
    name: 'add_tracking_exhausted_status',
    sql: `
      -- Add the recoverable 'tracking_exhausted' status to generation_jobs.
      --
      -- When the poller's bounded transient-failure budget is exhausted on an
      -- ALREADY-PAID job, the job is persisted as 'tracking_exhausted' (not
      -- 'failed') so the only recovery is a Resume that re-polls the SAME stored
      -- provider task id (no paid provider create). SQLite cannot ALTER a CHECK
      -- constraint in place, so the table is rebuilt with the expanded constraint.
      --
      -- FK-safe: no other table references generation_jobs, so the rebuild copies
      -- all rows into a new table, drops the old one, and recreates the indexes.
      CREATE TABLE generation_jobs__v2 (
        id                       TEXT PRIMARY KEY,
        prompt_id                TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        prompt_version_id        TEXT NOT NULL REFERENCES prompt_versions(id),
        rendered_prompt          TEXT NOT NULL,
        model                    TEXT NOT NULL,
        duration_seconds         INTEGER NOT NULL,
        aspect_ratio             TEXT NOT NULL,
        resolution               TEXT NOT NULL,
        first_frame_url          TEXT,
        last_frame_url           TEXT,
        reference_image_url      TEXT,
        reference_video_url      TEXT,
        reference_audio_url      TEXT,
        status                   TEXT NOT NULL DEFAULT 'queued'
                                   CHECK (status IN
                                     ('queued','running','succeeded','failed',
                                      'expired','tracking_exhausted')),
        provider                 TEXT NOT NULL,
        provider_task_id         TEXT,
        result_url               TEXT,
        error_code               TEXT,
        error_message            TEXT,
        idempotency_key          TEXT NOT NULL UNIQUE,
        idempotency_payload_hash TEXT NOT NULL,
        parameters               TEXT NOT NULL DEFAULT '{}',
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        completed_at             TEXT
      );

      INSERT INTO generation_jobs__v2
        (id, prompt_id, prompt_version_id, rendered_prompt, model,
         duration_seconds, aspect_ratio, resolution, first_frame_url,
         last_frame_url, reference_image_url, reference_video_url,
         reference_audio_url, status, provider, provider_task_id, result_url,
         error_code, error_message, idempotency_key, idempotency_payload_hash,
         parameters, created_at, updated_at, completed_at)
      SELECT id, prompt_id, prompt_version_id, rendered_prompt, model,
         duration_seconds, aspect_ratio, resolution, first_frame_url,
         last_frame_url, reference_image_url, reference_video_url,
         reference_audio_url, status, provider, provider_task_id, result_url,
         error_code, error_message, idempotency_key, idempotency_payload_hash,
         parameters, created_at, updated_at, completed_at
      FROM generation_jobs;

      DROP TABLE generation_jobs;
      ALTER TABLE generation_jobs__v2 RENAME TO generation_jobs;

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_prompt ON generation_jobs(prompt_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON generation_jobs(created_at);
    `,
  },
];

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function ensureMigrationsTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appliedVersions(db: DB): Set<number> {
  ensureMigrationsTable(db);
  const rows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

/** Apply all pending migrations inside a transaction. Idempotent. */
export function runMigrations(db: DB, migrations: Migration[] = MIGRATIONS): {
  applied: number[];
} {
  ensureMigrationsTable(db);
  const applied = appliedVersions(db);
  const pending = migrations
    .filter((m) => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { applied: [] };
  }

  db.exec('BEGIN');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    // Roll back the partial migration, but never let a rollback failure mask the
    // original error that caused the abort.
    try {
      db.exec('ROLLBACK');
    } catch {
      // Swallow rollback failure; the original error is re-thrown below.
    }
    throw error;
  }

  return { applied: pending.map((m) => m.version) };
}
