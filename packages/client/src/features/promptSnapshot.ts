/**
 * Pure helper for the generation composer's rendered-prompt consistency check.
 *
 * When a user inserts a camera cue (or hand-edits) the rendered prompt, the
 * composer freezes the exact text as a "prompt override" and records a snapshot
 * of the variable `values` that produced it. Later variable edits would make the
 * frozen text diverge from the values the server records, so the composer blocks
 * submission until the user re-syncs via "Reset to rendered". Staleness is
 * decided by comparing the recorded snapshot against a fresh snapshot of the
 * live values (see `promptOverrideValues` / `promptStale` in `Composer`).
 *
 * Encoding matters. A naïve `key=value` list joined by newlines is AMBIGUOUS:
 * a value may itself contain `\n` or `=` (e.g. pasted multi-line text), letting
 * two genuinely different value sets collapse to the same snapshot and silently
 * hide staleness. For example, under the old encoding both
 *   `{ a: "x\nb=y", b: "z" }`  and  `{ a: "x", b: "y\nb=z" }`
 * produced the string `a=x\nb=y\nb=z`, so a value change between them was not
 * detected.
 *
 * JSON-encoding the sorted `[key, value]` tuples is deterministic and
 * unambiguous: JSON string escapes neutralise embedded newlines/`=` and the
 * nested-array structure is its own delimiter, so distinct records never share a
 * snapshot. Keys are sorted by UTF-16 code unit (locale-independent, the default
 * `Array.prototype.sort`), so insertion order never affects the comparison.
 */
export function snapshotValues(values: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key] ?? '']),
  );
}
