import { describe, expect, it } from 'vitest';
import { snapshotValues } from './promptSnapshot.js';

/**
 * Regression for the rendered-prompt consistency encoding.
 *
 * The composer reads variable values from `<input type="text">` fields, which
 * the browser/jsdom sanitizes (newlines are stripped on input). The exact
 * colliding records below therefore cannot be driven through the DOM, so the
 * pure `snapshotValues` helper is tested directly — including the exact two
 * records the OLD `key=value\n` encoding collapsed to the same string. The
 * component-level stale path (which only depends on this helper) is covered by
 * the DOM-driven Composer test "blocks a stale prompt … until reset re-syncs it".
 */
describe('snapshotValues (rendered-prompt consistency encoding)', () => {
  // The two records the old `key=value\n` encoding reported as EQUAL: both
  // produced the string `a=x\nb=y\nb=z`, so a value change between them was not
  // detected and a touched prompt could be silently submitted with stale text.
  const recordA = { a: 'x\nb=y', b: 'z' };
  const recordB = { a: 'x', b: 'y\nb=z' };

  it('distinguishes the two records that the old encoding collapsed together', () => {
    expect(snapshotValues(recordA)).not.toBe(snapshotValues(recordB));
  });

  it('encodes embedded newlines/equals unambiguously (no separator collision)', () => {
    // The newline in recordA's value survives as a JSON escape, not a field
    // boundary, so the snapshot neither equals recordB nor a 3-key record.
    expect(snapshotValues(recordA)).not.toBe(snapshotValues({ a: 'x', b: 'y', c: 'b=z' }));
    expect(snapshotValues(recordB)).not.toBe(snapshotValues({ a: 'x', b: 'y', c: 'b=z' }));
  });

  it('is independent of key insertion order', () => {
    expect(snapshotValues({ a: 'x', b: 'z' })).toBe(snapshotValues({ b: 'z', a: 'x' }));
    expect(snapshotValues({ b: 'y\nb=z', a: 'x' })).toBe(snapshotValues(recordB));
  });

  it('is deterministic: the same values always produce the same snapshot', () => {
    expect(snapshotValues(recordA)).toBe(snapshotValues({ a: 'x\nb=y', b: 'z' }));
    // Snapshot of the empty record is a stable, falsy-distinct value (not '').
    expect(snapshotValues({})).toBe('[]');
    expect(snapshotValues({})).not.toBe('');
  });

  it('treats a missing value as an empty string', () => {
    // `values[key] ?? ''` defensively maps an absent/undefined value to ''. The
    // double cast models a sparse record the index signature would otherwise
    // reject; the encoded tuple must match a real empty-string value.
    expect(
      snapshotValues({ a: undefined } as unknown as Record<string, string>),
    ).toBe(snapshotValues({ a: '' }));
  });

  // Staleness is the composer's exact predicate:
  //   promptStale = promptTouched && promptOverrideValues !== snapshotValues(values)
  // where `promptOverrideValues` is the snapshot frozen at touch time. Replicated
  // here to prove a value change between the two colliding records flips a
  // touched prompt stale (and clears it again on return) — exactly what the old
  // encoding silently failed to do.
  function isStale(
    frozen: Record<string, string>,
    current: Record<string, string>,
  ): boolean {
    return snapshotValues(frozen) !== snapshotValues(current);
  }

  it('marks a touched prompt stale when values change between the two records', () => {
    expect(isStale(recordA, recordB)).toBe(true);
    expect(isStale(recordB, recordA)).toBe(true);
    // Consistent again once the live values return to the frozen snapshot.
    expect(isStale(recordA, recordA)).toBe(false);
    expect(isStale(recordB, recordB)).toBe(false);
  });
});
