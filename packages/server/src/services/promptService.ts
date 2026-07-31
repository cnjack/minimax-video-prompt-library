/**
 * Prompt + version domain logic: creation, versioning, restore-as-new-head,
 * duplication, and archive semantics. Keeps the prompt identity and immutable
 * versions consistent.
 */

import type { Prompt, PromptDetail, PromptVersion } from '@h3/shared';
import {
  ErrorCode,
  renderTemplate,
  TemplateSyntaxError,
  UnresolvedVariableError,
} from '@h3/shared';
import type { PromptRepository } from '../db/repositories/promptRepo.js';
import type { VersionRepository } from '../db/repositories/versionRepo.js';
import type { DB } from '../db/client.js';
import { runInTransaction } from '../db/client.js';
import { ApiError } from '../errors.js';
import { newId, nowIso } from '../util.js';

export interface CreatePromptInput {
  name: string;
  description: string;
  tags: string[];
  content: string;
  status: 'draft' | 'active';
}

export interface UpdatePromptInput {
  name?: string;
  description?: string;
  tags?: string[];
  status?: 'draft' | 'active' | 'archived';
}

export class PromptService {
  constructor(
    private readonly prompts: PromptRepository,
    private readonly versions: VersionRepository,
    private readonly db: DB,
  ) {}

  create(input: CreatePromptInput): PromptDetail {
    const now = nowIso();
    const promptId = newId();
    // Creating the prompt identity, its first immutable version, and the
    // current-version pointer must be atomic: a failure partway through must not
    // leave an orphaned prompt row with no version (or a prompt pointing at a
    // non-existent version). The whole create runs in one SQLite transaction.
    const head = runInTransaction(this.db, () => {
      this.prompts.create({
        id: promptId,
        name: input.name,
        description: input.description,
        tags: input.tags,
        status: input.status,
        now,
      });
      const created = this.versions.create({
        id: newId(),
        promptId,
        content: input.content,
        now,
      });
      this.prompts.setCurrentVersion(promptId, created.id, now);
      return created;
    });
    const prompt = this.prompts.getById(promptId);
    return {
      prompt: { ...(prompt as Prompt), currentVersionId: head.id },
      versions: [head],
    };
  }

  getDetail(id: string): PromptDetail {
    const prompt = this.requirePrompt(id);
    const versions = this.versions.listByPrompt(id);
    return { prompt, versions };
  }

  getById(id: string): Prompt {
    return this.requirePrompt(id);
  }

  list(query: {
    q?: string;
    status?: Prompt['status'];
    tag?: string;
    limit: number;
  }): Prompt[] {
    return this.prompts.list(query);
  }

  update(id: string, input: UpdatePromptInput): Prompt {
    const prompt = this.requirePrompt(id);
    if (prompt.status === 'archived' && input.status !== 'archived' && input.status === undefined) {
      // editing metadata (not un-archiving) on an archived prompt is allowed;
      // only new versions are blocked. No-op guard kept explicit.
    }
    const updated = this.prompts.update(id, { ...input, now: nowIso() });
    if (!updated) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Prompt ${id} not found.`);
    }
    return updated;
  }

  createVersion(promptId: string, content: string): PromptVersion {
    const prompt = this.requirePrompt(promptId);
    if (prompt.status === 'archived') {
      throw new ApiError(
        ErrorCode.ARCHIVED,
        'Cannot create a new version of an archived prompt. Restore it to active first.',
        { status: 409 },
      );
    }
    const version = this.versions.create({
      id: newId(),
      promptId,
      content,
      now: nowIso(),
    });
    this.prompts.setCurrentVersion(promptId, version.id, nowIso());
    return version;
  }

  /** Restore an old version by creating a new head with its content. */
  restoreVersion(promptId: string, versionId: string): PromptVersion {
    const prompt = this.requirePrompt(promptId);
    if (prompt.status === 'archived') {
      throw new ApiError(
        ErrorCode.ARCHIVED,
        'Cannot restore a version of an archived prompt.',
        { status: 409 },
      );
    }
    const target = this.versions.getById(versionId);
    if (!target || target.promptId !== promptId) {
      throw new ApiError(
        ErrorCode.NOT_FOUND,
        `Version ${versionId} not found for prompt ${promptId}.`,
      );
    }
    return this.createVersion(promptId, target.content);
  }

  duplicate(id: string, name?: string): PromptDetail {
    const source = this.requirePrompt(id);
    const head =
      source.currentVersionId
        ? this.versions.getById(source.currentVersionId)
        : this.versions.getLatest(id);
    if (!head) {
      throw new ApiError(
        ErrorCode.UNPROCESSABLE,
        `Prompt ${id} has no version to duplicate.`,
        { status: 422 },
      );
    }
    return this.create({
      name: name && name.trim().length > 0 ? name.trim() : `${source.name} (copy)`,
      description: source.description,
      tags: source.tags,
      content: head.content,
      status: 'draft',
    });
  }

  preview(content: string, values: Record<string, string>): { rendered: string } {
    try {
      return { rendered: renderTemplate(content, values) };
    } catch (error) {
      if (error instanceof UnresolvedVariableError) {
        throw new ApiError(
          ErrorCode.UNRESOLVED_VARIABLE,
          error.message,
          { status: 400, details: { variable: error.variable } },
        );
      }
      if (error instanceof TemplateSyntaxError) {
        throw new ApiError(ErrorCode.INVALID_TEMPLATE, error.message, {
          status: 400,
          details: { raw: error.raw },
        });
      }
      throw error;
    }
  }

  private requirePrompt(id: string): Prompt {
    const prompt = this.prompts.getById(id);
    if (!prompt) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Prompt ${id} not found.`);
    }
    return prompt;
  }
}
