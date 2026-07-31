/** Generation composer: render variables, pick H3 parameters, and submit a
 * protected generation request. Launched from a prompt version. */

import { useEffect, useMemo, useState } from 'react';
import {
  findMissingVariables,
  H3_ADAPTIVE_RATIO,
  H3_CONCRETE_RATIOS,
  H3_MAX_DURATION_SECONDS,
  H3_MIN_DURATION_SECONDS,
  H3_RATIOS,
  H3_RESOLUTION,
  mediaMode,
  renderTemplate,
  UnresolvedVariableError,
  type ProviderName,
} from '@h3/shared';
import type { CreateGenerationRequest } from '@h3/shared';
import { api, ApiClientError } from '../api/client.js';
import { useNav } from '../nav.js';
import { newRequestId } from '../util.js';
import { Badge, ErrorBanner, Field, Spinner } from '../components.js';

const MOCK_SCENARIOS = ['success', 'failure', 'expired', 'provider_error', 'slow'] as const;

export function Composer({
  promptId,
  versionId,
  mode,
}: {
  promptId: string;
  versionId: string;
  /** Provider mode from health. Mock-scenario controls only render when 'mock'. */
  mode?: ProviderName;
}) {
  const { go } = useNav();
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});

  const [duration, setDuration] = useState(6);
  const [aspectRatio, setAspectRatio] = useState<string>(H3_CONCRETE_RATIOS[0]);
  const [firstFrame, setFirstFrame] = useState('');
  const [lastFrame, setLastFrame] = useState('');
  const [refImage, setRefImage] = useState('');
  const [refVideo, setRefVideo] = useState('');
  const [refAudio, setRefAudio] = useState('');
  const [scenario, setScenario] = useState<(typeof MOCK_SCENARIOS)[number]>('success');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newRequestId);

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

  // Conditional H3 ratio behavior, exposed honestly in the UI:
  //  - text-to-video requires a concrete ratio;
  //  - first/last-frame mode is adaptive;
  //  - reference mode may use adaptive or concrete.
  const { mode: mediaModeValue, ratios: availableRatios, effectiveRatio } = useMemo(() => {
    const m = mediaMode({
      firstFrameUrl: firstFrame,
      lastFrameUrl: lastFrame,
      referenceImageUrl: refImage,
      referenceVideoUrl: refVideo,
      referenceAudioUrl: refAudio,
    });
    const ratios: readonly string[] =
      m === 'frame'
        ? [H3_ADAPTIVE_RATIO]
        : m === 'reference'
          ? H3_RATIOS
          : H3_CONCRETE_RATIOS;
    const ratio = ratios.includes(aspectRatio) ? aspectRatio : ratios[0]!;
    return { mode: m, ratios, effectiveRatio: ratio };
  }, [firstFrame, lastFrame, refImage, refVideo, refAudio, aspectRatio]);

  const canSubmit = missing.length === 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const body: CreateGenerationRequest = {
      promptVersionId: versionId,
      values,
      durationSeconds: duration,
      aspectRatio: effectiveRatio as CreateGenerationRequest['aspectRatio'],
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
      const message =
        e instanceof ApiClientError
          ? e.message
          : e instanceof Error && e.message.length > 0
            ? e.message
            : 'Failed to submit generation.';
      setError(message);
      // Keep the SAME idempotency key after transient/unknown failures so a
      // retry cannot create a paid duplicate at the provider. Rotate ONLY for a
      // deliberate idempotency conflict (same key, different payload), where a
      // fresh request is the intended next step.
      const isConflict =
        e instanceof ApiClientError && e.code === 'idempotency_conflict';
      if (isConflict) {
        setIdempotencyKey(newRequestId());
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner label="Loading composer…" />;

  const ratioHint =
    mediaModeValue === 'frame'
      ? 'First/last-frame mode uses an adaptive ratio.'
      : mediaModeValue === 'reference'
        ? 'Reference mode may use adaptive or a concrete ratio.'
        : 'Text-to-video requires an explicit (non-adaptive) ratio.';

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
            <Field label="Aspect ratio" htmlFor="c-ar" hint={ratioHint}>
              <select
                id="c-ar"
                value={effectiveRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                disabled={mediaModeValue === 'frame'}
              >
                {availableRatios.map((ar) => (
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
