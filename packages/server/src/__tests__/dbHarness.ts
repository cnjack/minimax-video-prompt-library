/**
 * Test harness: a fresh, file-backed SQLite database with migrations applied.
 * File-backed (not :memory:) so WAL pragmas and persistence semantics are
 * exercised realistically. Cleaned up per test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../db/client.js';
import { runMigrations } from '../db/migrations.js';

export interface TestDb {
  db: DB;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'h3-test-'));
  const dbPath = join(dir, 'test.db');
  const db = openDatabase(dbPath, { ensureDir: true });
  runMigrations(db);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
