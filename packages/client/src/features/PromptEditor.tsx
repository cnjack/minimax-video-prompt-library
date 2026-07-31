/** Prompt editor: metadata, versioned content, variable inputs, live preview,
 * version history with restore, duplicate, and archive. */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  findMissingVariables,
  parseTemplate,
  renderTemplate,
  TemplateSyntaxError,
  UnresolvedVariableError,
  type PromptDetail,
  type PromptStatus,
} from '@h3/shared';
import { api, ApiClientError } from '../api/client.js';
import { useNav } from '../nav.js';
import { Badge, ErrorBanner, Field, Spinner, Tag } from '../components.js';

function toCsv(tags: string[]): string {
  return tags.join(', ');
}
function fromCsv(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function PromptEditor({
  promptId,
  onNew,
}: {
  promptId: string;
  onNew: () => void;
}) {
  const { go } = useNav();
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsCsv, setTagsCsv] = useState('');
  const [status, setStatus] = useState<PromptStatus>('draft');

  const [content, setContent] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingMeta, setSavingMeta] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);

  // Track the prompt id this mount is actively loading so a slow response for an
  // old prompt (after the user navigated) is discarded rather than overwriting
  // the newly-selected prompt's form.
  const activePromptIdRef = useRef<string | null>(null);

  async function load(id: string = promptId) {
    setError(null);
    try {
      const d = await api.getPrompt(id);
      if (activePromptIdRef.current !== id) return; // stale response
      setDetail(d);
      setName(d.prompt.name);
      setDescription(d.prompt.description);
      setTagsCsv(toCsv(d.prompt.tags));
      setStatus(d.prompt.status);
      const head = d.versions[0];
      setContent(head?.content ?? '');
      setValues({});
    } catch (e) {
      if (activePromptIdRef.current !== id) return; // stale response
      setError(e instanceof ApiClientError ? e.message : 'Failed to load prompt.');
    }
  }

  useEffect(() => {
    activePromptIdRef.current = promptId;
    void load(promptId);
    return () => {
      // On promptId change or unmount, invalidate so in-flight loads are ignored.
      activePromptIdRef.current = null;
    };
  }, [promptId]);

  const parse = useMemo(() => {
    try {
      return { variables: parseTemplate(content).variables, error: null as string | null };
    } catch (e) {
      return {
        variables: [] as string[],
        error: e instanceof TemplateSyntaxError ? e.message : 'Invalid template.',
      };
    }
  }, [content]);

  const preview = useMemo(() => {
    try {
      return { rendered: renderTemplate(content, values), error: null as string | null };
    } catch (e) {
      const msg =
        e instanceof UnresolvedVariableError
          ? `Missing variable: ${e.variable}`
          : 'Preview unavailable.';
      return { rendered: '', error: msg };
    }
  }, [content, values]);

  const missing = useMemo(
    () => (parse.error ? [] : findMissingVariables(content, values)),
    [content, values, parse.error],
  );

  const headContent = detail?.versions[0]?.content ?? '';
  const contentDirty = content !== headContent && content.trim().length > 0;

  async function saveMetadata() {
    setSavingMeta(true);
    setNotice(null);
    try {
      const updated = await api.updatePrompt(promptId, {
        name,
        description,
        tags: fromCsv(tagsCsv),
        status,
      });
      setDetail((d) => (d ? { ...d, prompt: updated } : d));
      setNotice('Metadata saved.');
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to save metadata.');
    } finally {
      setSavingMeta(false);
    }
  }

  async function saveVersion() {
    if (!contentDirty || parse.error) return;
    setSavingVersion(true);
    setNotice(null);
    try {
      await api.createVersion(promptId, content);
      await load();
      setNotice('New version saved.');
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to save version.');
    } finally {
      setSavingVersion(false);
    }
  }

  async function restore(versionId: string) {
    setNotice(null);
    try {
      await api.restoreVersion(promptId, versionId);
      await load();
      setNotice('Restored as a new head version.');
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to restore version.');
    }
  }

  async function duplicate() {
    setNotice(null);
    try {
      const d = await api.duplicatePrompt(promptId, { name: `${name} (copy)` });
      go({ name: 'editor', promptId: d.prompt.id });
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to duplicate prompt.');
    }
  }

  async function archive() {
    setNotice(null);
    try {
      const updated = await api.archivePrompt(promptId);
      setStatus(updated.status);
      setDetail((cur) => (cur ? { ...cur, prompt: updated } : cur));
      setNotice('Prompt archived.');
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to archive prompt.');
    }
  }

  if (error && !detail) {
    return (
      <ErrorBanner message={error} />
    );
  }
  if (!detail) {
    return <Spinner label="Loading prompt…" />;
  }

  const head = detail.versions[0];

  return (
    <>
      <div className="topbar">
        <div>
          <button className="btn ghost sm" onClick={() => go({ name: 'library' })}>
            ← Library
          </button>
          <h1 style={{ marginTop: 8 }}>{detail.prompt.name}</h1>
          <div className="row" style={{ marginTop: 4 }}>
            <Badge status={detail.prompt.status} />
            {head ? <span className="muted">v{head.versionNumber} (head)</span> : null}
          </div>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={duplicate}>
            Duplicate
          </button>
          {detail.prompt.status !== 'archived' ? (
            <button className="btn sm danger" onClick={archive}>
              Archive
            </button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? (
        <div className="card" style={{ padding: '8px 12px', color: 'var(--accent-2)' }}>
          {notice}
        </div>
      ) : null}

      <div className="grid cols-2">
        <div>
          <div className="card">
            <div className="section-title">Details</div>
            <Field label="Name" htmlFor="p-name">
              <input
                id="p-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Description" htmlFor="p-desc">
              <textarea
                id="p-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ minHeight: 70 }}
              />
            </Field>
            <Field label="Tags (comma separated)" htmlFor="p-tags">
              <input
                id="p-tags"
                type="text"
                value={tagsCsv}
                onChange={(e) => setTagsCsv(e.target.value)}
              />
            </Field>
            <Field label="Status" htmlFor="p-status">
              <select
                id="p-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as PromptStatus)}
                disabled={detail.prompt.status === 'archived'}
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
            <button
              className="btn primary"
              onClick={saveMetadata}
              disabled={savingMeta}
            >
              {savingMeta ? 'Saving…' : 'Save details'}
            </button>
          </div>

          <div className="card">
            <div className="section-title">Version history</div>
            {detail.versions.length === 0 ? (
              <p className="muted">No versions.</p>
            ) : (
              detail.versions.map((v) => (
                <div className="version-item" key={v.id}>
                  <div>
                    <strong>v{v.versionNumber}</strong>{' '}
                    {v.id === detail.prompt.currentVersionId ? (
                      <span className="badge active">head</span>
                    ) : null}
                    <div className="muted">
                      {v.variables.length > 0
                        ? `vars: ${v.variables.join(', ')}`
                        : 'no variables'}
                      {' · '}
                      {new Date(v.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    onClick={() => restore(v.id)}
                    disabled={detail.prompt.status === 'archived'}
                  >
                    Restore
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <div className="row between">
              <div className="section-title" style={{ margin: 0 }}>
                Template content
              </div>
              {contentDirty ? (
                <span className="badge archived">unsaved</span>
              ) : null}
            </div>
            <Field label="Use {{variable}} placeholders" htmlFor="p-content" hint="A meaningful edit is saved as a new immutable version.">
              <textarea
                id="p-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className={parse.error ? 'invalid' : ''}
              />
            </Field>
            {parse.error ? <ErrorBanner message={parse.error} /> : null}

            {parse.variables.length > 0 ? (
              <>
                <div className="section-title">Variables</div>
                {parse.variables.map((vname) => (
                  <Field key={vname} label={vname} htmlFor={`var-${vname}`}>
                    <input
                      id={`var-${vname}`}
                      type="text"
                      value={values[vname] ?? ''}
                      onChange={(e) =>
                        setValues((s) => ({ ...s, [vname]: e.target.value }))
                      }
                      className={missing.includes(vname) ? 'invalid' : ''}
                    />
                  </Field>
                ))}
              </>
            ) : null}

            <div className="toolbar" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                onClick={saveVersion}
                disabled={!contentDirty || !!parse.error || savingVersion}
                title={parse.error ? 'Fix template errors first' : 'Save a new version'}
              >
                {savingVersion ? 'Saving…' : 'Save new version'}
              </button>
              <button
                className="btn"
                onClick={() =>
                  head && go({ name: 'composer', promptId, versionId: head.id })
                }
                disabled={!head || !!parse.error}
              >
                ▸ Generate from head
              </button>
            </div>
          </div>

          <div className="card">
            <div className="section-title">Live preview</div>
            {preview.error ? (
              <ErrorBanner message={preview.error} />
            ) : (
              <pre
                className="mono"
                style={{
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                  background: 'var(--bg-elev)',
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              >
                {preview.rendered}
              </pre>
            )}
            <div className="tags" style={{ marginTop: 10 }}>
              {parse.variables.map((t) => (
                <Tag key={t} name={t} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <button className="btn ghost sm" style={{ marginTop: 16 }} onClick={onNew}>
        + New prompt
      </button>
    </>
  );
}
