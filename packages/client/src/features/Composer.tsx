/** Generation composer: render variables, pick H3 parameters, and submit a
 * protected generation request. Launched from a prompt version. */

import { useEffect, useMemo, useState } from 'react';
import {
  findMissingVariables,
  H3_ASPECT_RATIOS,
  H3_MAX_DURATION_SECONDS,
  H3_MIN_DURATION_SECONDS,
  H3_RESOLUTION,
  renderTemplate,
  UnresolvedVariableError,
  type ProviderName,
} from '@h3/shared';
import type { CreateGenerationRequest } from '@h3/shared';
import { api, ApiClientError } from '../api/client.js';
import { useNav } from '../nav.js';
import { Badge, ErrorBanner, Field, Spinner } from '../components.js';

const MOCK_SCENARIOS = ['success', 'failure', 'expired', 'provider_error', 'slow'] as const;

function newKey(): string {
  return crypto.randomUUID();
}

export function Composer({
  promptId,
  versionId,
  mode,
}: {
  promptId: string;
  versionId: string;
  mode: ProviderName;
}) {
  const { go } = useNav();
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});

  const [duration, setDuration] = useState(6);
  const [aspectRatio, setAspectRatio] = useState<string>(H3_ASPECT_RATIOS[0]);
  const [firstFrame, setFirstFrame] = useState('');
  const [lastFrame, setLastFrame] = useState('');
  const [refImage, setRefImage] = useState('');
  const [refVideo, setRefVideo] = useState('');
  const [refAudio, setRefAudio] = useState('');
  const [scenario, setScenario] = useState<(typeof MOCK_SCENARIOS)[number]>('success');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = await api.getPrompt(promptId);
        const version = detail.versions.find((v) => v.id === versionId);
        if (cancelled) return;
        if (!version) {
          setError('Prompt version not found.');
          setLoading(false);
          return;
        }
        setContent(version.content);
        setVariables(version.variables);
        // Initialize values from variable names.
        const init: Record<string, string> = {};
        for (const v of version.variables) init[v] = '';
        setValues(init);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiClientError ? e.message : 'Failed to load version.');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [promptId, versionId]);

  const missing = useMemo(
    () => findMissingVariables(content, values),
    [content, values],
  );

  const preview = useMemo(() => {
    try {
      return renderTemplate(content, values);
    } catch (e) {
      return e instanceof UnresolvedVariableError
        ? `Missing variable: ${e.variable}`
        : 'Preview unavailable.';
    }
  }, [content, values]);

  const canSubmit = missing.length === 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const body: CreateGenerationRequest = {
      promptVersionId: versionId,
      values,
      durationSeconds: duration,
      aspectRatio: aspectRatio as CreateGenerationRequest['aspectRatio'],
      resolution: H3_RESOLUTION,
      firstFrameUrl: firstFrame || undefined,
      lastFrameUrl: lastFrame || undefined,
      referenceImageUrl: refImage || undefined,
      referenceVideoUrl: refVideo || undefined,
      referenceAudioUrl: refAudio || undefined,
      idempotencyKey,
      ...(mode === 'mock' ? { mockScenario: scenario } : {}),
    };
    try {
      const result = await api.createGeneration(body);
      go({ name: 'job', jobId: result.job.id });
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : e instanceof Error && e.message.length > 0
            ? e.message
            : 'Failed to submit generation.',
      );
      // A fresh key so the user can retry intentionally after a conflict.
      setIdempotencyKey(newKey());
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner label="Loading composer…" />;

  return (
    <>
      <div className="topbar">
        <div>
          <button
            className="btn ghost sm"
            onClick={() => go({ name: 'editor', promptId })}
          >
            ← Editor
          </button>
          <h1 style={{ marginTop: 8 }}>Generation composer</h1>
          <div className="row" style={{ marginTop: 4 }}>
            <Badge status="queued" />
            <span className="muted">model MiniMax-H3 · resolution {H3_RESOLUTION}</span>
          </div>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="grid cols-2">
        <div>
          <div className="card">
            <div className="section-title">Variables</div>
            {variables.length === 0 ? (
              <p className="muted">This template has no variables.</p>
            ) : (
              variables.map((v) => (
                <Field key={v} label={v} htmlFor={`c-${v}`}>
                  <input
                    id={`c-${v}`}
                    type="text"
                    value={values[v] ?? ''}
                    onChange={(e) =>
                      setValues((s) => ({ ...s, [v]: e.target.value }))
                    }
                    className={missing.includes(v) ? 'invalid' : ''}
                  />
                </Field>
              ))
            )}
            {missing.length > 0 ? (
              <ErrorBanner message={`Fill in all variables: ${missing.join(', ')}`} />
            ) : null}
          </div>

          <div className="card">
            <div className="section-title">Rendered prompt</div>
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
              {preview}
            </pre>
          </div>
        </div>

        <div>
          <div className="card">
            <div className="section-title">H3 parameters</div>
            <Field label={`Duration (${H3_MIN_DURATION_SECONDS}–${H3_MAX_DURATION_SECONDS} seconds)`} htmlFor="c-dur">
              <select
                id="c-dur"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {Array.from(
                  { length: H3_MAX_DURATION_SECONDS - H3_MIN_DURATION_SECONDS + 1 },
                  (_, i) => H3_MIN_DURATION_SECONDS + i,
                ).map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Aspect ratio (explicit, non-adaptive)" htmlFor="c-ar">
              <select
                id="c-ar"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
              >
                {H3_ASPECT_RATIOS.map((ar) => (
                  <option key={ar} value={ar}>
                    {ar}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Resolution" htmlFor="c-res">
              <select id="c-res" value={H3_RESOLUTION} disabled>
                <option value={H3_RESOLUTION}>{H3_RESOLUTION} (H3)</option>
              </select>
            </Field>

            {mode === 'mock' ? (
              <Field label="Mock scenario" htmlFor="c-scn" hint="Only available in mock mode.">
                <select
                  id="c-scn"
                  value={scenario}
                  onChange={(e) =>
                    setScenario(e.target.value as (typeof MOCK_SCENARIOS)[number])
                  }
                >
                  {MOCK_SCENARIOS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          <div className="card">
            <div className="section-title">Optional references (http(s) URLs)</div>
            <Field label="First frame image URL" htmlFor="c-ff">
              <input id="c-ff" type="url" value={firstFrame} onChange={(e) => setFirstFrame(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Last frame image URL" htmlFor="c-lf">
              <input id="c-lf" type="url" value={lastFrame} onChange={(e) => setLastFrame(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Reference image URL" htmlFor="c-ri">
              <input id="c-ri" type="url" value={refImage} onChange={(e) => setRefImage(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Reference video URL" htmlFor="c-rv">
              <input id="c-rv" type="url" value={refVideo} onChange={(e) => setRefVideo(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Reference audio URL" htmlFor="c-ra">
              <input id="c-ra" type="url" value={refAudio} onChange={(e) => setRefAudio(e.target.value)} placeholder="https://…" />
            </Field>
          </div>

          <button
            className="btn primary"
            onClick={submit}
            disabled={!canSubmit}
            title={missing.length > 0 ? 'Fill all variables first' : 'Submit generation'}
            style={{ marginTop: 4, width: '100%', justifyContent: 'center' }}
          >
            {submitting ? 'Submitting…' : '▶ Generate video'}
          </button>
          <p className="muted" style={{ marginTop: 8, textAlign: 'center' }}>
            Double-clicks are protected by an idempotency key.
          </p>
        </div>
      </div>
    </>
  );
}
