/**
 * Immutable prompt-version repository. Version numbers are 1-based and always
 * increasing within a prompt; versions are never mutated, only superseded.
 */

import type { PromptVersion } from '@h3/shared';
import { parseTemplate } from '@h3/shared';
import type { DB } from '../client.js';

interface VersionRow {
  id: string;
  prompt_id: string;
  version_number: number;
  content: string;
  variables: string;
  created_at: string;
}

function mapRow(row: VersionRow): PromptVersion {
  let variables: string[] = [];
  try {
    const parsed = JSON.parse(row.variables) as unknown;
    if (Array.isArray(parsed)) {
      variables = parsed.filter((v): v is string => typeof v === 'string');
    }
  } catch {
    variables = [];
  }
  return {
    id: row.id,
    promptId: row.prompt_id,
    versionNumber: row.version_number,
    content: row.content,
    variables,
    createdAt: row.created_at,
  };
}

export interface CreateVersionInput {
  id: string;
  promptId: string;
  content: string;
  now: string;
}

export class VersionRepository {
  constructor(private readonly db: DB) {}

  /** Detects variables from content automatically. */
  create(input: CreateVersionInput): PromptVersion {
    const { variables } = parseTemplate(input.content);
    const versionNumber = this.nextVersionNumber(input.promptId);
    this.db
      .prepare(
        `INSERT INTO prompt_versions
           (id, prompt_id, version_number, content, variables, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.promptId,
        versionNumber,
        input.content,
        JSON.stringify(variables),
        input.now,
      );
    return this.getById(input.id) as PromptVersion;
  }

  getById(id: string): PromptVersion | null {
    const row = this.db
      .prepare('SELECT * FROM prompt_versions WHERE id = ?')
      .get(id) as VersionRow | undefined;
    return row ? mapRow(row) : null;
  }

  getByPromptAndNumber(
    promptId: string,
    versionNumber: number,
  ): PromptVersion | null {
    const row = this.db
      .prepare(
        'SELECT * FROM prompt_versions WHERE prompt_id = ? AND version_number = ?',
      )
      .get(promptId, versionNumber) as VersionRow | undefined;
    return row ? mapRow(row) : null;
  }

  listByPrompt(promptId: string): PromptVersion[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version_number DESC',
      )
      .all(promptId) as unknown as VersionRow[];
    return rows.map(mapRow);
  }

  getLatest(promptId: string): PromptVersion | null {
    const rows = this.listByPrompt(promptId);
    return rows[0] ?? null;
  }

  nextVersionNumber(promptId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(version_number), 0) AS max FROM prompt_versions WHERE prompt_id = ?',
      )
      .get(promptId) as { max: number };
    return row.max + 1;
  }
}
