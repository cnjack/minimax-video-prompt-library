import { describe, expect, it } from 'vitest';
import {
  findMissingVariables,
  parseTemplate,
  renderTemplate,
  TemplateSyntaxError,
  UnresolvedVariableError,
} from '../template.js';

describe('parseTemplate', () => {
  it('detects a single variable', () => {
    expect(parseTemplate('Hello {{name}}!')).toEqual({
      variables: ['name'],
      hasPlaceholders: true,
    });
  });

  it('normalizes duplicate variables and preserves first-occurrence order', () => {
    const parsed = parseTemplate('{{b}} {{a}} {{b}} {{c}} {{a}}');
    expect(parsed.variables).toEqual(['b', 'a', 'c']);
  });

  it('tolerates whitespace inside braces', () => {
    expect(parseTemplate('{{  name  }}').variables).toEqual(['name']);
  });

  it('supports dot, hyphen, underscore, and digits in names', () => {
    expect(parseTemplate('{{user.name}} {{shot-01}} {{a_b}} {{x1}}').variables).toEqual([
      'user.name',
      'shot-01',
      'a_b',
      'x1',
    ]);
  });

  it('has no variables when there are no placeholders', () => {
    expect(parseTemplate('plain text')).toEqual({ variables: [], hasPlaceholders: false });
  });

  it('rejects empty placeholders', () => {
    expect(() => parseTemplate('bad {{}} here')).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate('bad {{ }} here')).toThrow(TemplateSyntaxError);
  });

  it('rejects invalid variable names', () => {
    expect(() => parseTemplate('{{bad name}}')).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate('{{naïve}}')).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate('{{a/b}}')).toThrow(TemplateSyntaxError);
  });
});

describe('renderTemplate', () => {
  it('substitutes all variables', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 2');
  });

  it('substitutes repeated variables', () => {
    expect(renderTemplate('{{x}}-{{x}}', { x: 'y' })).toBe('y-y');
  });

  it('throws on an unresolved variable', () => {
    try {
      renderTemplate('{{missing}}', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnresolvedVariableError);
      expect((e as UnresolvedVariableError).variable).toBe('missing');
    }
  });

  it('treats blank values as unresolved', () => {
    expect(() => renderTemplate('{{x}}', { x: '   ' })).toThrow(UnresolvedVariableError);
  });

  it('throws on invalid template syntax during render', () => {
    expect(() => renderTemplate('{{bad name}}', {})).toThrow(TemplateSyntaxError);
  });
});

describe('findMissingVariables', () => {
  it('returns missing variable names', () => {
    expect(findMissingVariables('{{a}}{{b}}', { a: 'ok' })).toEqual(['b']);
  });

  it('returns empty when all satisfied', () => {
    expect(findMissingVariables('{{a}}', { a: 'ok' })).toEqual([]);
  });
});
