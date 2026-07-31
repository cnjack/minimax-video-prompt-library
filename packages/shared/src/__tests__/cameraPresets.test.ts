import { describe, expect, it } from 'vitest';
import {
  CAMERA_PRESETS,
  findCameraPreset,
  insertTokenAtSelection,
} from '../cameraPresets.js';

describe('CAMERA_PRESETS', () => {
  it('exposes the minimum required H3 camera-motion cues', () => {
    const labels = CAMERA_PRESETS.map((p) => p.label);
    expect(labels).toEqual([
      'Pan left',
      'Pan right',
      'Push in',
      'Pull out',
      'Tracking shot',
      'Static shot',
    ]);
  });

  it('every preset has a stable id, a non-empty token, and a description', () => {
    for (const preset of CAMERA_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.token.trim().length).toBeGreaterThan(0);
      expect(preset.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('ids are unique (safe React keys / test selectors)', () => {
    const ids = CAMERA_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('findCameraPreset resolves by id and returns undefined for unknown ids', () => {
    expect(findCameraPreset('pan-left')?.label).toBe('Pan left');
    expect(findCameraPreset('nope')).toBeUndefined();
  });
});

describe('insertTokenAtSelection', () => {
  it('inserts at the start, adding a trailing space so the rest reads naturally', () => {
    const result = insertTokenAtSelection('hello world', 0, 0, 'pan left');
    expect(result.text).toBe('pan left hello world');
    // Caret lands right after the inserted token word.
    expect(result.selectionStart).toBe('pan left'.length);
    expect(result.selectionEnd).toBe('pan left'.length);
  });

  it('inserts in the middle at the cursor without duplicating spacing', () => {
    // Cursor sits on the existing space between the two words.
    const result = insertTokenAtSelection('hello world', 5, 5, 'pan left');
    expect(result.text).toBe('hello pan left world');
    expect(result.selectionStart).toBe('hello pan left'.length);
    expect(result.selectionEnd).toBe('hello pan left'.length);
  });

  it('inserts in the middle between non-space characters with spacing on both sides', () => {
    // Cursor between "ab" and "cd" with no surrounding whitespace.
    const result = insertTokenAtSelection('abcd', 2, 2, 'pan left');
    expect(result.text).toBe('ab pan left cd');
    expect(result.selectionStart).toBe('ab pan left'.length);
  });

  it('appends at the end with a leading space', () => {
    const result = insertTokenAtSelection('hello world', 11, 11, 'pan left');
    expect(result.text).toBe('hello world pan left');
    expect(result.selectionStart).toBe('hello world pan left'.length);
    expect(result.selectionEnd).toBe('hello world pan left'.length);
  });

  it('replaces the current selection with the token', () => {
    // "hello" (0..5) is selected and replaced.
    const result = insertTokenAtSelection('hello world', 0, 5, 'static shot');
    expect(result.text).toBe('static shot world');
    expect(result.selectionStart).toBe('static shot'.length);
    expect(result.selectionEnd).toBe('static shot'.length);
  });

  it('does not add a leading space when replacing a selection at the start', () => {
    const result = insertTokenAtSelection('hello world', 0, 5, 'tracking shot');
    expect(result.text).toBe('tracking shot world');
    expect(result.text.at(0)).not.toBe(' ');
  });

  it('does not double up whitespace adjacent to existing whitespace', () => {
    // Leading space already present before the cursor.
    const result = insertTokenAtSelection('hello ', 6, 6, 'push in');
    expect(result.text).toBe('hello push in');
  });

  it('handles an empty prompt by becoming just the token', () => {
    const result = insertTokenAtSelection('', 0, 0, 'pan left');
    expect(result.text).toBe('pan left');
    expect(result.selectionStart).toBe('pan left'.length);
  });

  it('clamps out-of-range selection indices into the text bounds', () => {
    const tooFar = insertTokenAtSelection('hi', 999, 999, 'pan left');
    expect(tooFar.text).toBe('hi pan left');
  });

  it('treats a non-finite cursor (uninitialized) as the end of the text', () => {
    const result = insertTokenAtSelection('hi', Number.NaN, Number.NaN, 'pan left');
    expect(result.text).toBe('hi pan left');
  });

  it('normalizes a reversed selection (start > end) like a forward selection', () => {
    const result = insertTokenAtSelection('hello world', 5, 0, 'static shot');
    expect(result.text).toBe('static shot world');
  });

  it('is pure: the inputs are not mutated', () => {
    const original = 'hello world';
    insertTokenAtSelection(original, 5, 5, 'pan left');
    expect(original).toBe('hello world');
  });
});
