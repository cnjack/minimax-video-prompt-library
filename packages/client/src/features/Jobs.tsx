/** Job history list and job detail view. The client polls the server's job
 * endpoint (never the provider) to reflect the server-side poller's updates. */

import { useCallback, useEffect, useRef, useState } from 'react';
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
                  {j.model} · {j.durationSeconds}s · {j.resolution}
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
  // Per-jobId retry-token cache, scoped to this mounted instance's lifetime.
  // Kept in a ref (NOT state) so mutating it never triggers a re-render.
  //
  // This preserves retry idempotency across A→B→A navigation: an unresolved
  // retry for job A (response lost / unknown HTTP outcome) must keep A's token
  // so revisiting A reuses it — minting a fresh token would create a SECOND
  // paid provider job, since server idempotency is keyed by this client token.
  // Each job still gets its OWN distinct first token (so A's token never leaks
  // to B and collides with B's payload-hash idempotency record).
  const tokensByJobId = useRef<Map<string, string>>(new Map());

  /** Get-or-create the retained retry token for a job. Idempotent. */
  const getRetryToken = useCallback((id: string): string => {
    const existing = tokensByJobId.current.get(id);
    if (existing) return existing;
    const token = newRequestId();
    tokensByJobId.current.set(id, token);
    return token;
  }, []);

  /** After an observed retry RESPONSE for a job, replace its cached token so the
   * next deliberate retry is a new attempt (a fresh job), not a reuse. Safe to
   * call even after navigation: it only touches this job's cache entry. */
  const rotateRetryToken = useCallback((id: string): void => {
    tokensByJobId.current.set(id, newRequestId());
  }, []);

  const [retryToken, setRetryToken] = useState<string>(() => getRetryToken(jobId));
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mirror the current jobId into a ref on every render so an in-flight retry()
  // — whose closure captured the jobId from when it was STARTED — can still read
  // the LATEST job identity after navigation. This is what lets a retry for job A
  // that settles while job B is displayed detect that it is no longer current.
  const jobIdRef = useRef(jobId);
  jobIdRef.current = jobId;

  // On every job change: adopt that job's RETAINED token from the cache (or mint
  // a new one the first time it is seen), and reset the visible retry state —
  // the newly displayed job has not started a retry. The token cache itself is
  // deliberately NOT cleared, which is what preserves A→B→A token retention.
  useEffect(() => {
    setRetryToken(getRetryToken(jobId));
    setRetrying(false);
  }, [jobId, getRetryToken]);

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
    // Capture the identity of THIS attempt. A retry that settles AFTER the user
    // has navigated to a different job must not overwrite the now-current job's
    // token/error/retrying state or navigate away from it. It may still update
    // this job's CACHED token after a known response, but every VISIBLE side
    // effect below is guarded by `attemptJobId === jobIdRef.current` (still
    // current). The ref (not the closed-over `jobId`) is read so a retry started
    // on job A still sees job B as current after navigation.
    const attemptJobId = jobId;
    const attemptToken = retryToken;
    setRetrying(true);
    setError(null);
    try {
      const result = await api.retryJob(attemptJobId, attemptToken);
      // A response was observed for this job: rotate its cached token so the
      // next deliberate retry is a new attempt (a fresh job), not a reuse. This
      // only touches this job's cache entry, so it is safe after navigation.
      rotateRetryToken(attemptJobId);
      if (attemptJobId !== jobIdRef.current) return;
      // Adopt the freshly rotated token into the visible state (only when this
      // job is still the current one).
      setRetryToken(getRetryToken(attemptJobId));
      if (!result.reused || !TERMINAL.includes(result.job.status)) {
        // A fresh (or still in-progress) job — navigate to it. Navigation may
        // occur only if the initiating job is still current.
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
      // Outcome unknown or failed: KEEP the token (do not rotate) so a resend
      // reuses the same retried job (no double charge). Do not touch visible
      // state unless this job is still current.
      if (attemptJobId === jobIdRef.current) {
        setError(e instanceof ApiClientError ? e.message : 'Failed to retry job.');
      }
    } finally {
      if (attemptJobId === jobIdRef.current) {
        setRetrying(false);
      }
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
