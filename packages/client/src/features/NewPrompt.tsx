/** Inline form to create a new prompt with its first version. */

import { useMemo, useState } from 'react';
import { parseTemplate, TemplateSyntaxError } from '@h3/shared';
import { api, ApiClientError } from '../api/client.js';
import { useNav } from '../nav.js';
import { ErrorBanner, Field, Spinner } from '../components.js';

export function NewPrompt({ onCancel }: { onCancel: () => void }) {
  const { go } = useNav();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsCsv, setTagsCsv] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templateError = useMemo(() => {
    try {
      parseTemplate(content);
      return null;
    } catch (e) {
      return e instanceof TemplateSyntaxError ? e.message : 'Invalid template.';
    }
  }, [content]);

  async function submit() {
    if (!name.trim() || !content.trim() || templateError) return;
    setSubmitting(true);
    setError(null);
    try {
      const detail = await api.createPrompt({
        name: name.trim(),
        description: description.trim(),
        tags: tagsCsv
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        content: content.trim(),
        status,
      });
      go({ name: 'editor', promptId: detail.prompt.id });
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to create prompt.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitting) return <Spinner label="Creating prompt…" />;

  return (
    <>
      <div className="topbar">
        <h1>New prompt</h1>
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="card">
        <Field label="Name" htmlFor="n-name">
          <input id="n-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="n-desc">
          <textarea
            id="n-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ minHeight: 70 }}
          />
        </Field>
        <Field label="Tags (comma separated)" htmlFor="n-tags">
          <input id="n-tags" type="text" value={tagsCsv} onChange={(e) => setTagsCsv(e.target.value)} />
        </Field>
        <Field label="Status" htmlFor="n-status">
          <select id="n-status" value={status} onChange={(e) => setStatus(e.target.value as 'draft' | 'active')}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
          </select>
        </Field>
        <Field label="Template content" htmlFor="n-content" hint="Use {{variable}} placeholders. Variables are detected automatically.">
          <textarea
            id="n-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className={templateError && content.length > 0 ? 'invalid' : ''}
          />
        </Field>
        {templateError && content.length > 0 ? <ErrorBanner message={templateError} /> : null}
        <button
          className="btn primary"
          onClick={submit}
          disabled={!name.trim() || !content.trim() || !!templateError}
        >
          Create prompt
        </button>
      </div>
    </>
  );
}
