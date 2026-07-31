import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './dbHarness.js';
import { runInTransaction } from '../db/client.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { PromptRepository } from '../db/repositories/promptRepo.js';
import type { VersionRepository } from '../db/repositories/versionRepo.js';
import { PromptService } from '../services/promptService.js';

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe('runInTransaction: preserve original error on rollback failure', () => {
  it('re-throws the original error when ROLLBACK itself fails', () => {
    const db = testDb.db;
    const realExec = db.exec.bind(db);
    (db as { exec: (sql: string) => void }).exec = (sql: string) => {
      if (sql.trim().toUpperCase() === 'ROLLBACK') {
        throw new Error('rollback boom');
      }
      return realExec(sql);
    };

    const original = new Error('original cause');
    expect(() => runInTransaction(db, () => { throw original; })).toThrow(original);

    (db as { exec: (sql: string) => void }).exec = realExec;
  });
});

describe('PromptService.create atomicity', () => {
  it('rolls back prompt creation when the first version fails (no partial row)', () => {
    const prompts = new PromptRepository(testDb.db);
    const throwingVersions = {
      create: () => {
        throw new Error('version boom');
      },
    } as unknown as VersionRepository;
    const svc = new PromptService(prompts, throwingVersions, testDb.db);

    expect(() =>
      svc.create({ name: 'P', description: '', tags: [], content: 'x', status: 'active' }),
    ).toThrow('version boom');

    // No orphaned prompt row remains: the whole create was one transaction.
    expect(prompts.count()).toBe(0);
  });

  it('commits atomically on success (prompt + version + pointer together)', () => {
    const prompts = new PromptRepository(testDb.db);
    const versions = {
      create: () => ({ id: 'v-head', promptId: 'ignored', versionNumber: 1, content: 'x', variables: [], createdAt: 't' }),
    } as unknown as VersionRepository;
    const svc = new PromptService(prompts, versions, testDb.db);
    const detail = svc.create({ name: 'P', description: '', tags: [], content: 'x', status: 'active' });
    expect(prompts.count()).toBe(1);
    expect(prompts.getById(detail.prompt.id)?.currentVersionId).toBe('v-head');
  });
});

describe('runMigrations: preserve original error on rollback failure', () => {
  it('re-throws the migration error (not the rollback error) when rollback fails', () => {
    const db = testDb.db;
    const realExec = db.exec.bind(db);
    (db as { exec: (sql: string) => void }).exec = (sql: string) => {
      if (sql.trim().toUpperCase() === 'ROLLBACK') {
        throw new Error('rollback boom');
      }
      return realExec(sql);
    };

    // v1 is already applied by createTestDb; this deliberately-invalid v999 fails.
    const badMigration = { version: 999, name: 'bad', sql: 'CREATE TABLE broken (' };
    let caught: unknown;
    try {
      runMigrations(db, [...MIGRATIONS, badMigration]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // The ORIGINAL migration error propagates; the rollback failure must not mask it.
    expect((caught as Error).message).not.toMatch(/rollback/i);

    (db as { exec: (sql: string) => void }).exec = realExec;
  });
});
