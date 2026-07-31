/**
 * SQLite client built on Node's built-in `node:sqlite` (no native add-ons).
 *
 * The experimental `node:sqlite` builtin is loaded with `createRequire` so the
 * value is resolved at runtime (under `--experimental-sqlite`) and is never
 * statically analyzed by Vite/esbuild during tests or the client build. The
 * type comes from `@types/node` via a type-only import (erased at runtime).
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const sqliteRequire = createRequire(import.meta.url);
const OpenDatabaseSync = sqliteRequire('node:sqlite').DatabaseSync as new (
  location: string,
) => DatabaseSync;

/** SQLite bind values we use across repositories. */
export type SqlBind = Array<string | number | null>;

export interface OpenDbOptions {
  /** Create the parent directory of the db file when true. */
  ensureDir?: boolean;
}

export function openDatabase(dbPath: string, options: OpenDbOptions = {}): DB {
  if (options.ensureDir !== false) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new OpenDatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

/**
 * Run `fn` inside a single SQLite transaction (BEGIN … COMMIT). If `fn` (or the
 * COMMIT) throws, the transaction is rolled back. If the rollback ITSELF fails,
 * the ORIGINAL error is preserved and re-thrown — the rollback failure is never
 * allowed to mask the cause of the abort.
 *
 * SQLite (via `node:sqlite`) serializes writes on a single connection, so this
 * is safe for this single-instance PoC.
 */
export function runInTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // Attempt rollback but never let it mask the original error.
    try {
      db.exec('ROLLBACK');
    } catch {
      // Swallow rollback failure; the original error is re-thrown below.
    }
    throw error;
  }
}
