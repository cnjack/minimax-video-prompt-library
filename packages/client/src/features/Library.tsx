/** Library view: search, filter, and the prompt grid. */

import { useEffect, useState } from 'react';
import type { Prompt } from '@h3/shared';
import { api, ApiClientError } from '../api/client.js';
import { useNav } from '../nav.js';
import { Badge, CenterState, ErrorBanner, Spinner, Tag } from '../components.js';

type StatusFilter = '' | 'draft' | 'active' | 'archived';

export function Library({ onNew }: { onNew: () => void }) {
  const { go } = useNav();
  const [items, setItems] = useState<Prompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');

  async function load() {
    setError(null);
    try {
      const res = await api.listPrompts({ q: q || undefined, status: status || undefined });
      setItems(res.items);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to load prompts.');
      setItems([]);
    }
  }

  useEffect(() => {
    void load();
  }, [q, status]);

  return (
    <>
      <div className="topbar">
        <h1>Prompt Library</h1>
        <div className="actions">
          <button className="btn primary" onClick={onNew}>
            + New prompt
          </button>
        </div>
      </div>

      <div className="toolbar" style={{ marginBottom: 18 }}>
        <input
          type="search"
          placeholder="Search by name, description, or tag…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search prompts"
          className="grow"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {items === null ? (
        <CenterState icon="" title="">
          <Spinner label="Loading prompts…" />
        </CenterState>
      ) : items.length === 0 ? (
        <CenterState icon="✦" title="No prompts yet">
          <p>Create your first prompt template to start generating H3 videos.</p>
          <button className="btn primary" onClick={onNew} style={{ marginTop: 12 }}>
            + New prompt
          </button>
        </CenterState>
      ) : (
        <div className="grid cols-2">
          {items.map((p) => (
            <div
              key={p.id}
              className="prompt-card"
              role="button"
              tabIndex={0}
              onClick={() => go({ name: 'editor', promptId: p.id })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  go({ name: 'editor', promptId: p.id });
                }
              }}
            >
              <div className="row between wrap">
                <h3>{p.name}</h3>
                <Badge status={p.status} />
              </div>
              <p className="desc">{p.description || 'No description.'}</p>
              <div className="tags">
                {p.tags.map((t) => (
                  <Tag key={t} name={t} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
