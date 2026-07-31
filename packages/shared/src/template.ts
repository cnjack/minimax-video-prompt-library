/**
 * Template engine — a deep, pure module.
 *
 * Templates use `{{variable}}` placeholders. Variable names may contain
 * letters, numbers, underscore (`_`), dot (`.`) and hyphen (`-`). Whitespace
 * inside the braces is tolerated (`{{ name }}`). Duplicate occurrences of the
 * same variable are normalized to a single variable. Blank/invalid names and
 * unresolved variables are rejected.
 *
 * This module has no dependencies and no side effects so it can be unit-tested
 * exhaustively and reused on both client and server.
 */

export const VARIABLE_PATTERN = /\{\{\s*([^}]*?)\s*\}\}/g;

/** A valid variable name: letters, numbers, underscore, dot, hyphen. */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface ParsedTemplate {
  /** Unique variable names, in first-occurrence order. */
  variables: string[];
  /** True if the template contains at least one placeholder. */
  hasPlaceholders: boolean;
}

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

/**
 * Extract the unique set of variables from a template string, in the order they
 * first appear. Throws if the template contains an empty or invalid placeholder
 * (e.g. `{{}}`, `{{ bad name }}`).
 */
export function parseTemplate(template: string): ParsedTemplate {
  const seen = new Set<string>();
  const variables: string[] = [];

  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const inner = match[1];
    if (inner === undefined) {
      continue;
    }
    const name = inner.trim();
    if (name.length === 0) {
      throw new TemplateSyntaxError(
        'Template contains an empty placeholder "{{}}".',
        match[0],
      );
    }
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      throw new TemplateSyntaxError(
        `Template variable "${name}" is invalid. Use only letters, numbers, underscore, dot, and hyphen.`,
        name,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      variables.push(name);
    }
  }

  return { variables, hasPlaceholders: variables.length > 0 };
}

export type VariableValues = Record<string, string>;

/**
 * Validate that every variable in the template has a non-blank value. Returns
 * the set of missing variable names (empty if all satisfied).
 */
export function findMissingVariables(
  template: string,
  values: VariableValues,
): string[] {
  const { variables } = parseTemplate(template);
  return variables.filter((name) => {
    const value = values[name];
    return value === undefined || value === null || value.trim().length === 0;
  });
}

/**
 * Render a template by substituting every placeholder with its value.
 * Throws `TemplateSyntaxError` for an invalid placeholder, and
 * `UnresolvedVariableError` if a variable has no value.
 */
export function renderTemplate(
  template: string,
  values: VariableValues,
): string {
  return template.replace(VARIABLE_PATTERN, (full, inner: string) => {
    const name = inner.trim();
    if (name.length === 0) {
      throw new TemplateSyntaxError(
        'Template contains an empty placeholder "{{}}".',
        full,
      );
    }
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      throw new TemplateSyntaxError(
        `Template variable "${name}" is invalid.`,
        name,
      );
    }
    const value = values[name];
    if (value === undefined || value === null || value.trim().length === 0) {
      throw new UnresolvedVariableError(name);
    }
    return value;
  });
}

export class UnresolvedVariableError extends Error {
  constructor(readonly variable: string) {
    super(`Template variable "${variable}" has no value.`);
    this.name = 'UnresolvedVariableError';
  }
}
