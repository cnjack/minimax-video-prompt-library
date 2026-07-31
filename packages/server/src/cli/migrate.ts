/**
 * Standalone migration command: `pnpm migrate`. Opens the configured database,
 * applies pending migrations, prints the result, and exits. Safe to run
 * repeatedly (idempotent).
 */

import { loadConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';

const config = loadConfig();
const db = openDatabase(config.dbPath, { ensureDir: true });
const { applied } = runMigrations(db);

if (applied.length === 0) {
  console.info(`[migrate] database is up to date (${MIGRATIONS.length} migration(s) known).`);
} else {
  console.info(`[migrate] applied ${applied.length} migration(s): ${applied.join(', ')}`);
}

db.close();
