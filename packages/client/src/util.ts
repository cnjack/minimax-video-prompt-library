/**
 * Browser-safe id helpers. `crypto.randomUUID()` requires a secure context
 * (HTTPS or localhost) and throws on plain-HTTP origins, so `newRequestId`
 * falls back to a `crypto.getRandomValues`-based RFC-4122 v4 id, and finally to
 * a Math.random fallback, so idempotency keys are always available.
 */

const HEX = '0123456789abcdef';

function randomUUUIDv4(): string | null {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === 'function') {
    try {
      return g.randomUUID();
    } catch {
      // Not a secure context — fall through.
    }
  }
  if (g && typeof g.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    g.getRandomValues(bytes);
    // Set version (4) and variant bits per RFC 4122.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    let out = '';
    for (let i = 0; i < 16; i++) {
      const b = bytes[i]!;
      out += HEX[b >> 4]! + HEX[b & 0x0f]!;
      if (i === 3 || i === 5 || i === 7 || i === 9) {
        out += '-';
      }
    }
    return out;
  }
  return null;
}

export function newRequestId(): string {
  const uuid = randomUUUIDv4();
  if (uuid) return uuid;
  // Last-resort fallback (non-cryptographic), still unique enough for a key.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
