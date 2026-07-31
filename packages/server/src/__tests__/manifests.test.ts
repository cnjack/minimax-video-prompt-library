import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('Kubernetes manifests (kubectl kustomize structural/security assertions)', () => {
  it('does not apply a committed Secret (never overwrites an operator credential)', () => {
    const kustomization = read('k8s/kustomization.yaml');
    expect(kustomization).not.toMatch(/secret\.yaml/);
    expect(existsSync(join(root, 'k8s/secret.yaml'))).toBe(false);
    // The README documents the out-of-band creation path.
    expect(read('README.md')).toMatch(/create secret/i);
  });

  it('runs as a non-root UID/GID with dropped capabilities, no privilege escalation, read-only root, and RuntimeDefault seccomp', () => {
    const deploy = read('k8s/deployment.yaml');
    // Pod-level identity matches the image (10001), never root.
    expect(deploy).toMatch(/runAsNonRoot:\s*true/);
    expect(deploy).toMatch(/runAsUser:\s*10001/);
    expect(deploy).toMatch(/runAsGroup:\s*10001/);
    expect(deploy).toMatch(/fsGroup:\s*10001/);
    // seccomp.
    expect(deploy).toMatch(/RuntimeDefault/);
    // Container hardening.
    expect(deploy).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(deploy).toMatch(/readOnlyRootFilesystem:\s*true/);
    expect(deploy).toMatch(/drop:/);
    expect(deploy).toMatch(/-\s*ALL/);
    // The MiniMax secret is optional so mock mode runs with no secret present.
    expect(deploy).toMatch(/optional:\s*true/);
    expect(deploy).toMatch(/h3-prompt-studio-secrets/);
  });

  it('keeps /data writable but adds no unnecessary /tmp emptyDir', () => {
    const deploy = read('k8s/deployment.yaml');
    expect(deploy).toMatch(/mountPath:\s*\/data/);
    // No /tmp mount and no emptyDir volume (assert on the actual YAML keys).
    expect(deploy).not.toMatch(/mountPath:\s*\/tmp/);
    expect(deploy).not.toMatch(/emptyDir:/);
  });

  it('documents deployment-time replacement of the mutable image tag with an immutable reference', () => {
    const deploy = read('k8s/deployment.yaml');
    expect(deploy).toMatch(/IMMUTABLE registry|immutable registry|digest/i);
  });
});

describe('Dockerfile runtime hardening', () => {
  it('uses an environment-neutral base image, runs as a named non-root UID/GID, and owns /data', () => {
    const dockerfile = read('Dockerfile');
    // Neutral public base (not a private/local registry), both stages.
    expect(dockerfile).toMatch(/FROM node:22-bookworm-slim/);
    // Named non-root identity owning the persisted data dir.
    expect(dockerfile).toMatch(/groupadd[\s\S]*--gid 10001 h3/);
    expect(dockerfile).toMatch(/useradd[\s\S]*--uid 10001[\s\S]*h3/);
    expect(dockerfile).toMatch(/mkdir -p \/data/);
    expect(dockerfile).toMatch(/chown -R h3:h3 \/data/);
    expect(dockerfile).toMatch(/USER 10001:10001/);
  });
});

describe('.dockerignore', () => {
  it('excludes every .env variant while allowing only .env.example', () => {
    const di = read('.dockerignore');
    expect(di).toMatch(/^\.env$/m);
    expect(di).toMatch(/^\.env\.\*$/m);
    expect(di).toMatch(/^!\.env\.example$/m);
  });
});

describe('no committed credentials', () => {
  it('ships no real-looking MiniMax key and only a commented placeholder', () => {
    const envExample = read('.env.example');
    expect(envExample).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(envExample).toMatch(/#\s*MINIMAX_API_KEY=/);
  });
});
