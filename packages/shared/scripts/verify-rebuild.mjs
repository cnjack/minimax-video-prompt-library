// Regression guard for the composite-build "stale tsbuildinfo" bug.
//
// Problem this guards against: with `composite: true`, `tsc` is incremental and
// writes a `.tsbuildinfo` file. If that file lives OUTSIDE `dist`, then deleting
// only `dist` leaves the `.tsbuildinfo` behind. On the next build `tsc` sees an
// up-to-date program and exits 0 WITHOUT re-emitting `dist` — so the package is
// silently shipped with no build output.
//
// The fix keeps `tsBuildInfoFile` INSIDE `dist` (see packages/shared/tsconfig.json),
// so removing `dist` also removes the build info and forces a real re-emit.
//
// This script verifies BOTH the configuration shape and the runtime behavior. The
// behavioral check compiles the REAL sources (so module/@types resolution is
// identical to a real build) but emits into a throwaway sandbox `dist`, so the
// real `dist` is never disturbed.
//
//   1. the real tsconfig.json keeps tsBuildInfoFile under outDir (or disables
//      incremental), and
//   2. with that config shape, deleting dist forces tsc to recreate dist.
//
// Run: `node packages/shared/scripts/verify-rebuild.mjs`
// Exit status 0 = pass, 1 = regression.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveTscBin() {
  try {
    return require.resolve('typescript/bin/tsc');
  } catch {
    return null;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveExtends(extendsValue, configDir) {
  if (!extendsValue) return undefined;
  return isAbsolute(extendsValue) ? extendsValue : resolve(configDir, extendsValue);
}

const realConfigPath = join(pkgRoot, 'tsconfig.json');
const realConfig = readJson(realConfigPath);

// --- 1. Configuration shape guard -----------------------------------------
const compilerOptions = realConfig.compilerOptions ?? {};
const outDir = compilerOptions.outDir ?? './dist';
const tsBuildInfoFile = compilerOptions.tsBuildInfoFile;
const incrementalDisabled = compilerOptions.incremental === false;
const outDirPrefix = outDir.endsWith('/') ? outDir : `${outDir}/`;
const infoUnderDist =
  typeof tsBuildInfoFile === 'string' &&
  (tsBuildInfoFile === outDir || tsBuildInfoFile.startsWith(outDirPrefix));

if (!infoUnderDist && !incrementalDisabled) {
  console.error(
    `CONFIG REGRESSION: tsBuildInfoFile must live inside outDir ("${outDir}") or incremental must be false. ` +
      `Got tsBuildInfoFile=${String(tsBuildInfoFile)}.`,
  );
  process.exit(1);
}

// --- 2. Behavioral guard (sandboxed emit, real sources) --------------------
const tscBin = resolveTscBin();
if (!tscBin) {
  console.error('Could not resolve the typescript compiler (typescript/bin/tsc).');
  process.exit(1);
}

function runTsc(cwd) {
  return spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
    cwd,
    encoding: 'utf8',
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'h3-shared-rebuild-'));
try {
  // Build a tsconfig in the sandbox that compiles the REAL sources (absolute
  // rootDir/include → identical module + @types resolution to a real build) but
  // emits into the sandbox outDir. outDir/tsBuildInfoFile stay relative so they
  // resolve under the sandbox, mirroring the real config.
  // Workspace root, where @types/node is hoisted (the real build finds it via
  // typeRoots walking up from packages/shared).
  const workspaceRoot = resolve(pkgRoot, '../..');
  const sandboxConfig = {
    compilerOptions: {
      ...compilerOptions,
      rootDir: join(pkgRoot, 'src'),
      // Both kept relative to the sandbox dir so they land under tmp/dist:
      outDir: './dist',
      // Resolve node globals (e.g. `URL`) exactly like the real build does.
      typeRoots: [join(workspaceRoot, 'node_modules/@types')],
      types: ['node'],
    },
    include: [join(pkgRoot, 'src/**/*')],
    exclude: [
      join(pkgRoot, 'src/**/*.test.ts'),
      join(pkgRoot, 'src/__tests__/**'),
    ],
  };
  const extendsAbs = resolveExtends(realConfig.extends, pkgRoot);
  if (extendsAbs) {
    sandboxConfig.extends = extendsAbs;
  }
  writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify(sandboxConfig, null, 2));

  // Initial build must succeed and emit dist.
  let r = runTsc(tmp);
  if (r.status !== 0) {
    console.error('Initial build failed:\n' + r.stdout + r.stderr);
    process.exit(1);
  }
  if (!existsSync(join(tmp, 'dist', 'index.js'))) {
    console.error('Initial build did not emit dist/index.js');
    process.exit(1);
  }

  // Simulate `dist` being deleted while the build-info would otherwise survive.
  rmSync(join(tmp, 'dist'), { recursive: true, force: true });

  // The build-info lives inside dist, so it is now gone too. Rebuilding must
  // therefore re-emit dist. (On the broken config the tsbuildinfo survived and
  // this build was a no-op, leaving dist empty.)
  r = runTsc(tmp);
  if (r.status !== 0) {
    console.error('Rebuild after removing dist failed:\n' + r.stdout + r.stderr);
    process.exit(1);
  }
  if (!existsSync(join(tmp, 'dist', 'index.js'))) {
    console.error(
      'REGRESSION: dist/index.js was NOT recreated after removing dist. ' +
        'A stale .tsbuildinfo caused tsc to exit 0 without emitting output.',
    );
    process.exit(1);
  }

  console.log('OK: shared dist is recreated after dist is removed (no stale tsbuildinfo no-op).');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
