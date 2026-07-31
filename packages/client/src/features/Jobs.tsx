/** Job history list and job detail view. The client polls the server's job
 * endpoint (never the provider) to reflect the server-side poller's updates. */

import { useEffect, useRef, useState } from 'react';
import type { GenerationJob, JobStatus } from '@h3/shared';
import { api, ApiClientError } from '../api/client.js';
import { useNav } from '../nav.js';
import { newRequestId } from '../util.js';
import { Badge, CenterState, ErrorBanner, Spinner } from '../components.js';

const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'expired'];
const POLL_MS = 2000;

export function JobsList() {
  const { go } = useNav();
  const [jobs, setJobs] = useState<GenerationJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'' | JobStatus>('');

  // Filter-keyed polling lifecycle. Each filter change starts a fresh lifecycle:
  // an AbortController cancels the previous in-flight request and a `cancelled`
  // flag ignores any straggler response, so a slow response for an old filter
  // can never overwrite the current filter's data (mirrors JobDetail). This
  // matters because filters can change faster than the network resolves.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      try {
        const res = await api.listJobs(
          { status: filter || undefined },
          { signal: controller.signal },
        );
        // Ignore responses from a superseded filter or an aborted request.
        if (cancelled || controller.signal.aborted) return;
        setJobs(res.items);
        setError(null);
      } catch (e) {
        if (cancelled || controller.signal.aborted) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiClientError ? e.message : 'Failed to load jobs.');
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [filter]);

  return (
    <>
      <div className="topbar">
        <h1>Generation history</h1>
      </div>

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as '' | JobStatus)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="expired">Expired</option>
        </select>
        <span className="muted grow" style={{ textAlign: 'right' }}>
          Auto-refreshing every {POLL_MS / 1000}s
        </span>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {jobs === null ? (
        <Spinner label="Loading jobs…" />
      ) : jobs.length === 0 ? (
        <CenterState icon="◐" title="No generations yet">
          <p>Submit a generation from a prompt to see it here.</p>
        </CenterState>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {jobs.map((j) => (
            <button
              key={j.id}
              className="version-item"
              style={{ width: '100%', cursor: 'pointer', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'inherit', textAlign: 'left' }}
              onClick={() => go({ name: 'job', jobId: j.id })}
            >
              <div>
                <Badge status={j.status} pulse={j.status === 'running'} />
                <div className="muted" style={{ marginTop: 4 }}>
                  {j.model} · {j.durationSeconds}s · {j.aspectRatio}
                  {' · '}
                  {new Date(j.createdAt).toLocaleString()}
                </div>
                {j.errorMessage ? (
                  <div className="muted" style={{ color: 'var(--danger)' }}>
                    {j.errorMessage}
                  </div>
                ) : null}
              </div>
              <span className="muted">→</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function JobDetail({ jobId }: { jobId: string }) {
  const { go } = useNav();
  const [retryToken, setRetryToken] = useState<string>(newRequestId);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // The retry idempotency token is scoped to ONE jobId. When the SAME mounted
  // component navigates from job A to job B (hash/deep-link or browser history
  // back/forward), A's retained token must NOT be reused for B — reusing it
  // would collide with A's payload-hash idempotency record on the server. A
  // fresh token per jobId preserves the intended rule in retry(): a resend for
  // the SAME job after an unknown HTTP outcome reuses that job's token.
  useEffect(() => {
    setRetryToken(newRequestId());
  }, [jobId]);

  // Single polling lifecycle keyed on jobId: load once, poll while non-terminal,
  // and on cleanup (jobId change or unmount) both clear AND null the timer so it
  // can never leak or double-fire across renders.
  useEffect(() => {
    let cancelled = false;
    timer.current = null;

    const load = async () => {
      try {
        const j = await api.getJob(jobId);
        if (cancelled) return;
        setJob(j);
        setError(null);
        if (TERMINAL.includes(j.status) && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiClientError ? e.message : 'Failed to load job.');
      }
    };

    void load();
    timer.current = setInterval(() => void load(), POLL_MS);

    return () => {
      cancelled = true;
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [jobId]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const result = await api.retryJob(jobId, retryToken);
      // A response was observed: rotate the token so the next deliberate retry
      // click is a new attempt (a fresh job), not a reuse of this one.
      setRetryToken(newRequestId());
      if (!result.reused || !TERMINAL.includes(result.job.status)) {
        // A fresh (or still in-progress) job — navigate to it.
        go({ name: 'job', jobId: result.job.id });
      } else {
        // This retry attempt already finished terminally (e.g. a transport retry
        // that returned an already-failed retried job). Do NOT silently navigate
        // to a stale failed job; surface it and let the user retry again.
        setError(
          `This retry already finished (${result.job.status}). Click retry to start a fresh job.`,
        );
      }
    } catch (e) {
      // Outcome unknown or failed: KEEP the token so a resend reuses the same
      // retried job (no double charge). Do not rotate here.
      setError(e instanceof ApiClientError ? e.message : 'Failed to retry job.');
    } finally {
      setRetrying(false);
    }
  }

  if (error && !job) return <ErrorBanner message={error} />;
  if (!job) return <Spinner label="Loading job…" />;

  const isTerminal = TERMINAL.includes(job.status);

  return (
    <>
      <div className="topbar">
        <div>
          <button className="btn ghost sm" onClick={() => go({ name: 'jobs' })}>
            ← History
          </button>
          <h1 style={{ marginTop: 8 }}>
            <Badge status={job.status} pulse={job.status === 'running'} /> Generation
          </h1>
        </div>
        <div className="actions">
          {(job.status === 'failed' || job.status === 'expired') && (
            <button className="btn" onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : '↻ Retry as new job'}
            </button>
          )}
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {!isTerminal ? (
        <div className="card">
          <Spinner label={`Job is ${job.status}. Waiting for updates…`} />
        </div>
      ) : null}

      {job.status === 'succeeded' && job.resultUrl ? (
        <div className="card">
          <div className="section-title">Result</div>
          <video className="video-frame" src={job.resultUrl} controls />
          <div className="row" style={{ marginTop: 10 }}>
            <a href={job.resultUrl} target="_blank" rel="noreferrer">
              Open result ↗
            </a>
          </div>
        </div>
      ) : null}

      {(job.status === 'failed' || job.status === 'expired') && job.errorMessage ? (
        <div className="card">
          <div className="section-title">Outcome</div>
          <ErrorBanner message={job.errorMessage} code={job.errorCode ?? undefined} />
        </div>
      ) : null}

      <div className="card">
        <div className="section-title">Details</div>
        <dl className="kv">
          <dt>Job ID</dt>
          <dd className="mono">{job.id}</dd>
          <dt>Provider</dt>
          <dd>{job.provider}</dd>
          <dt>Provider task</dt>
          <dd className="mono">{job.providerTaskId ?? '—'}</dd>
          <dt>Model</dt>
          <dd>{job.model}</dd>
          <dt>Duration</dt>
          <dd>{job.durationSeconds}s</dd>
          <dt>Aspect ratio</dt>
          <dd>{job.aspectRatio}</dd>
          <dt>Resolution</dt>
          <dd>{job.resolution}</dd>
          <dt>Created</dt>
          <dd>{new Date(job.createdAt).toLocaleString()}</dd>
          <dt>Updated</dt>
          <dd>{new Date(job.updatedAt).toLocaleString()}</dd>
          {job.completedAt ? (
            <>
              <dt>Completed</dt>
              <dd>{new Date(job.completedAt).toLocaleString()}</dd>
            </>
          ) : null}
          <dt>Idempotency key</dt>
          <dd className="mono">{job.idempotencyKey}</dd>
        </dl>

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
          {job.renderedPrompt}
        </pre>
      </div>
    </>
  );
}
