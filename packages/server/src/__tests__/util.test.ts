import { describe, expect, it } from 'vitest';
import { compareCodeUnits, computePayloadHash, sortRecord } from '../util.js';

const base = {
  promptVersionId: 'v1',
  durationSeconds: 6,
  resolution: '768P',
};

describe('computePayloadHash determinism (locale-independent code-unit ordering)', () => {
  it('is identical regardless of value-key insertion order', () => {
    const a = computePayloadHash({ ...base, values: { a: '1', B: '2', Z: '3' } });
    const b = computePayloadHash({ ...base, values: { Z: '3', a: '1', B: '2' } });
    expect(a).toBe(b);
  });

  it('is stable across repeated calls', () => {
    const input = { ...base, values: { subject: 'cat', 'foo.bar': 'x' } };
    expect(computePayloadHash(input)).toBe(computePayloadHash(input));
  });

  it('is order-independent for punctuation and non-ASCII keys', () => {
    const entries: Array<[string, string]> = [
      ['_b', '1'],
      ['Z', '2'],
      ['é', '3'],
      ['.c', '4'],
      ['-d', '5'],
    ];
    const v1 = Object.fromEntries(entries);
    const v2 = Object.fromEntries([...entries].reverse());
    expect(computePayloadHash({ ...base, values: v1 })).toBe(
      computePayloadHash({ ...base, values: v2 }),
    );
  });

  it('produces different hashes for different payloads', () => {
    expect(computePayloadHash({ ...base, values: { a: '1' } })).not.toBe(
      computePayloadHash({ ...base, values: { a: '2' } }),
    );
  });

  it('produces different hashes for different prompt overrides', () => {
    expect(
      computePayloadHash({ ...base, values: { a: '1' }, prompt: 'pan left' }),
    ).not.toBe(computePayloadHash({ ...base, values: { a: '1' }, prompt: 'push in' }));
  });
});

describe('compareCodeUnits / sortRecord', () => {
  it('orders by UTF-16 code unit (uppercase before lowercase), independent of locale', () => {
    expect(compareCodeUnits('A', 'a')).toBe(-1); // 65 < 97
    expect(compareCodeUnits('a', 'A')).toBe(1);
    expect(compareCodeUnits('a', 'a')).toBe(0);
    // '_' (95) sorts after uppercase letters but before lowercase letters.
    expect(compareCodeUnits('Z', '_')).toBe(-1); // 90 < 95
    expect(compareCodeUnits('_', 'a')).toBe(-1); // 95 < 97
  });

  it('sorts keys deterministically by code unit', () => {
    const sorted = sortRecord({ b: '2', A: '1', _: '3', é: '4' });
    expect(Object.keys(sorted)).toEqual(['A', '_', 'b', 'é']);
  });
});
