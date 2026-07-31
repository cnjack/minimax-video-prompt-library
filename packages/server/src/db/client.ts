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
