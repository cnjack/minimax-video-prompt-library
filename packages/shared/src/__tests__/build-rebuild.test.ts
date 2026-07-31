import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the composite-build "stale tsbuildinfo" bug.
 *
 * With `composite: true`, `tsc` is incremental and writes a `.tsbuildinfo`.
 * If that file lives outside `dist`, deleting only `dist` leaves the build info
 * behind and the next `tsc` exits 0 WITHOUT re-emitting `dist`. Keeping
 * `tsBuildInfoFile` inside `dist` (see packages/shared/tsconfig.json) forces a
 * real re-emit whenever `dist` is removed.
 *
 * The verification runs in an isolated temp dir via the standalone script so the
 * real `dist` is never disturbed.
 */
describe('shared composite build regression', () => {
  it('recreates dist after dist is removed (no stale tsbuildinfo no-op build)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = join(here, '..', '..', 'scripts', 'verify-rebuild.mjs');
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      // Allow tsc to run a couple of times in the sandbox.
      timeout: 90_000,
    });
    const detail = `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, `verify-rebuild should pass.${detail}`).toBe(0);
  });
});
