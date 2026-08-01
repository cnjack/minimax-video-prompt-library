import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../server.js';
import { openDatabase } from '../db/client.js';
import type { AppConfig } from '../config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'h3-boot-'));
}

function mockConfig(dbPath: string, port: number): AppConfig {
  return {
    port,
    nodeEnv: 'test',
    dbPath,
    providerMode: 'mock',
    minimaxApiKey: null,
    minimaxBaseUrl: 'https://api.minimax.io',
    minimaxGroupId: null,
    pollIntervalMs: 60_000,
    pollMaxAttempts: 5,
    clientDist: null,
    seedSamples: false,
    instanceId: 'boot-test',
  };
}

/** Grab an ephemeral free port by binding to :0, then releasing it. */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
    });
    srv.on('error', reject);
  });
}

/** Hold a port open so a subsequent bind to it fails with EADDRINUSE. */
function occupyPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(port, () => resolve(srv));
    srv.on('error', reject);
  });
}

describe('boot() lifecycle', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('listens, serves /api/health, starts the poller only after listen, and registers no signal handlers', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const port = await ephemeralPort();

    const pollerSpy = { start: vi.fn(), stop: vi.fn() };
    const createPoller = vi.fn(() => pollerSpy);

    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const booted = await boot(mockConfig(join(dir, 'app.db'), port), {
      createPoller,
    });

    try {
      // Listening succeeded → poller started AFTER the bind.
      expect(createPoller).toHaveBeenCalledTimes(1);
      expect(pollerSpy.start).toHaveBeenCalledTimes(1);

      // The server serves health.
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe('mock');

      // boot() itself must NOT register signal handlers (only the direct path does).
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    } finally {
      await booted.close();
      expect(pollerSpy.stop).toHaveBeenCalledTimes(1);
    }
  }, 15_000);

  it('rejects on a bind failure (EADDRINUSE), closes the DB, and never starts the poller', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const port = await ephemeralPort();

    // Hold the port so boot's bind collides with it.
    const holder = await occupyPort(port);

    const realDb = openDatabase(join(dir, 'fail.db'));
    const closeSpy = vi.spyOn(realDb, 'close');
    const pollerSpy = { start: vi.fn(), stop: vi.fn() };
    const createPoller = vi.fn(() => pollerSpy);

    try {
      await expect(
        boot(mockConfig(join(dir, 'fail.db'), port), {
          openDatabase: () => realDb,
          createPoller,
        }),
      ).rejects.toThrow();

      // The DB was closed on the failed bind, and the poller never started.
      expect(closeSpy).toHaveBeenCalled();
      expect(createPoller).not.toHaveBeenCalled();
      expect(pollerSpy.start).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 15_000);

  it('propagates a shutdown (db.close) failure so the direct-execution path can exit non-zero', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const port = await ephemeralPort();

    const realDb = openDatabase(join(dir, 'shutdown.db'));
    // Replace close so shutdown's db.close() throws (simulating a close failure).
    Object.assign(realDb, {
      close: vi.fn(() => {
        throw new Error('db close failed on shutdown');
      }),
    });

    const booted = await boot(mockConfig(join(dir, 'shutdown.db'), port), {
      openDatabase: () => realDb,
    });

    // shutdown() must reject (propagate db.close failure) instead of swallowing it.
    await expect(booted.close()).rejects.toThrow('db close failed on shutdown');
  }, 15_000);
});
