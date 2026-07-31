/** Application shell: sidebar navigation, health/mode badge, view routing. */

import { useEffect, useState } from 'react';
import type { HealthStatus, ProviderName } from '@h3/shared';
import { api } from './api/client.js';
import { NavProvider, useNav } from './nav.js';
import { Library } from './features/Library.js';
import { PromptEditor } from './features/PromptEditor.js';
import { Composer } from './features/Composer.js';
import { JobsList, JobDetail } from './features/Jobs.js';
import { NewPrompt } from './features/NewPrompt.js';

function Shell() {
  const { view } = useNav();
  const [creating, setCreating] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const mode: ProviderName = health?.mode ?? 'mock';

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const h = await api.getHealth();
        if (active) setHealth(h);
      } catch {
        /* health is informational */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const onNew = () => setCreating(true);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">H3</div>
          <div>
            <div className="brand-name">Prompt Studio</div>
            <div className="brand-sub">MiniMax H3 workspace</div>
          </div>
        </div>
        <button
          className={`nav-btn ${view.name === 'library' && !creating ? 'active' : ''}`}
          onClick={() => {
            setCreating(false);
            window.location.hash = '#/';
          }}
        >
          <span aria-hidden="true">▦</span> Library
        </button>
        <button
          className={`nav-btn ${view.name === 'jobs' || view.name === 'job' ? 'active' : ''}`}
          onClick={() => {
            setCreating(false);
            window.location.hash = '#/jobs';
          }}
        >
          <span aria-hidden="true">◐</span> Generations
        </button>

        <div className="sidebar-foot">
          {health ? (
            <>
              <div>
                Provider:{' '}
                <strong style={{ color: mode === 'minimax' ? 'var(--success)' : 'var(--accent-2)' }}>
                  {mode}
                </strong>
              </div>
              <div>
                {health.providerConfigured ? 'configured' : 'not configured'}
              </div>
            </>
          ) : (
            'connecting…'
          )}
        </div>
      </aside>

      <main className="main">
        {creating ? (
          <NewPrompt onCancel={() => setCreating(false)} />
        ) : view.name === 'editor' ? (
          <PromptEditor promptId={view.promptId} onNew={onNew} />
        ) : view.name === 'composer' ? (
          <Composer promptId={view.promptId} versionId={view.versionId} mode={mode} />
        ) : view.name === 'jobs' ? (
          <JobsList />
        ) : view.name === 'job' ? (
          <JobDetail jobId={view.jobId} />
        ) : (
          <Library onNew={onNew} />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <NavProvider>
      <Shell />
    </NavProvider>
  );
}
