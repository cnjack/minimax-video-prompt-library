/**
 * Prompt identity repository. Tags are stored as JSON. The search supports
 * substring matching across name, description, and tags (the documented
 * full-text-search stand-in for this single-instance PoC).
 */

import type { Prompt, PromptStatus } from '@h3/shared';
import type { ListPromptsQuery } from '@h3/shared';
import type { DB, SqlBind } from '../client.js';

interface PromptRow {
  id: string;
  name: string;
  description: string;
  tags: string;
  status: PromptStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function mapRow(row: PromptRow): Prompt {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) {
      tags = parsed.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags,
    status: row.status,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export interface CreatePromptInput {
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: PromptStatus;
  now: string;
}

export interface UpdatePromptInput {
  name?: string;
  description?: string;
  tags?: string[];
  status?: PromptStatus;
  now: string;
}

export class PromptRepository {
  constructor(private readonly db: DB) {}

  create(input: CreatePromptInput): Prompt {
    this.db
      .prepare(
        `INSERT INTO prompts
           (id, name, description, tags, status, current_version_id, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.name,
        input.description,
        JSON.stringify(input.tags),
        input.status,
        input.now,
        input.now,
      );
    return this.getById(input.id) as Prompt;
  }

  getById(id: string): Prompt | null {
    const row = this.db
      .prepare('SELECT * FROM prompts WHERE id = ?')
      .get(id) as PromptRow | undefined;
    return row ? mapRow(row) : null;
  }

  exists(id: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS one FROM prompts WHERE id = ?')
      .get(id) as { one: number } | undefined;
    return row !== undefined;
  }

  list(query: ListPromptsQuery): Prompt[] {
    const where: string[] = [];
    const params: SqlBind = [];

    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.tag) {
      where.push('tags LIKE ?');
      params.push(`%"${query.tag.replace(/[%_"]/g, ' ')}"%`);
    }
    if (query.q) {
      where.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)');
      const term = `%${query.q.replace(/[%_]/g, ' ')}%`;
      params.push(term, term, term);
    }

    const sql = `SELECT * FROM prompts
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC
      LIMIT ?`;
    params.push(query.limit);

    const rows = this.db.prepare(sql).all(...params) as unknown as PromptRow[];
    return rows.map(mapRow);
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM prompts')
      .get() as { n: number };
    return row.n;
  }

  update(id: string, input: UpdatePromptInput): Prompt | null {
    const setClauses: string[] = ['updated_at = ?'];
    const params: SqlBind = [input.now];

    if (input.name !== undefined) {
      setClauses.push('name = ?');
      params.push(input.name);
    }
    if (input.description !== undefined) {
      setClauses.push('description = ?');
      params.push(input.description);
    }
    if (input.tags !== undefined) {
      setClauses.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (input.status !== undefined) {
      setClauses.push('status = ?');
      params.push(input.status);
      if (input.status === 'archived') {
        setClauses.push('archived_at = ?');
        params.push(input.now);
      } else {
        setClauses.push('archived_at = NULL');
      }
    }

    params.push(id);
    this.db
      .prepare(`UPDATE prompts SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.getById(id);
  }

  setCurrentVersion(id: string, versionId: string, now: string): void {
    this.db
      .prepare(
        'UPDATE prompts SET current_version_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(versionId, now, id);
  }

  archive(id: string, now: string): Prompt | null {
    return this.update(id, { status: 'archived', now });
  }
}
