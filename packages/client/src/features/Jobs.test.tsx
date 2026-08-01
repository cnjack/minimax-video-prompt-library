import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { GenerationJob } from '@h3/shared';
import { NavProvider } from '../nav.js';
import { JobDetail, JobsList } from './Jobs.js';

const { goSpy } = vi.hoisted(() => ({ goSpy: vi.fn() }));

vi.mock('../nav.js', () => ({
  // Passthrough provider; useNav returns a spy so navigation calls are observable.
  NavProvider: ({ children }: { children: ReactNode }) => children,
  useNav: () => ({ go: goSpy }),
}));

vi.mock('../api/client.js', () => ({
  api: {
    listJobs: vi.fn(),
    getJob: vi.fn(),
    retryJob: vi.fn(),
  },
  ApiClientError: class extends Error {
    readonly code: string;
    readonly status: number;
    readonly requestId: string;
    constructor(body: { message: string; code: string; status: number; requestId: string }) {
      super(body.message);
      this.name = 'ApiClientError';
      this.code = body.code;
      this.status = body.status;
      this.requestId = body.requestId;
    }
  },
}));

import { api, ApiClientError } from '../api/client.js';

const listJobs = vi.mocked(api.listJobs);
const getJob = vi.mocked(api.getJob);
const retryJob = vi.mocked(api.retryJob);

function makeJob(o: Partial<GenerationJob> & { id: string }): GenerationJob {
  const defaults: GenerationJob = {
    id: 'default',
    promptId: 'p1',
    promptVersionId: 'v1',
    renderedPrompt: 'x',
    model: 'MiniMax-Hailuo-2.3',
    durationSeconds: 6,
    aspectRatio: 'native',
    resolution: '768P',
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrl: null,
    referenceVideoUrl: null,
    referenceAudioUrl: null,
    status: 'queued',
    provider: 'mock',
    providerTaskId: null,
    resultUrl: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: 'k',
    idempotencyPayloadHash: 'h',
    parameters: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    completedAt: null,
  };
  return { ...defaults, ...o };
}

const allJob = makeJob({ id: 'all-1', resolution: '1080P' });
const failedJob = makeJob({ id: 'failed-1', status: 'failed' });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderJobsList() {
  return render(
    <NavProvider>
      <JobsList />
    </NavProvider>,
  );
}

beforeEach(() => {
  listJobs.mockReset();
});

describe('JobsList filter cancellation', () => {
  it('renders jobs for the initial filter', async () => {
    listJobs.mockResolvedValue({ items: [allJob], total: 1 });
    renderJobsList();
    await waitFor(() => expect(screen.getByText(/1080P/)).toBeInTheDocument());
  });

  it('ignores a stale response from a previous filter (defensive guard)', async () => {
    // The mock does NOT respect the abort signal: the "all" response resolves
    // late, after the filter has already switched. The component must ignore it.
    const allDeferred = createDeferred<{ items: GenerationJob[]; total: number }>();
    listJobs.mockImplementation((query, _options) => {
      if (query?.status === 'failed') {
        return Promise.resolve({ items: [failedJob], total: 1 });
      }
      return allDeferred.promise;
    });

    const user = userEvent.setup();
    renderJobsList();

    // Switch the filter to "failed" while the "all" request is still pending.
    const select = screen.getByLabelText(/Filter by status/i);
    await user.selectOptions(select, 'failed');
    await waitFor(() => expect(screen.getByText(/768P/)).toBeInTheDocument());

    // Now the stale "all" response arrives. It must NOT overwrite "failed".
    allDeferred.resolve({ items: [allJob], total: 1 });
    await waitFor(() => {
      expect(screen.queryByText(/1080P/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/768P/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load jobs/i)).not.toBeInTheDocument();
  });

  it('aborts the in-flight request when the filter changes (cancellation)', async () => {
    // The mock respects the abort signal: the "all" request rejects with an
    // AbortError on filter change, which the component swallows (no error banner).
    listJobs.mockImplementation((query, options) => {
      const signal = options?.signal;
      if (query?.status === 'failed') {
        return Promise.resolve({ items: [failedJob], total: 1 });
      }
      // "all" stays pending until aborted; only this branch owns a deferred so
      // there is no orphaned (unawaited) promise to reject at cleanup.
      const d = createDeferred<{ items: GenerationJob[]; total: number }>();
      const onAbort = () =>
        d.reject(new DOMException('aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return d.promise;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      return d.promise;
    });

    const user = userEvent.setup();
    renderJobsList();

    const select = screen.getByLabelText(/Filter by status/i);
    await user.selectOptions(select, 'failed');

    await waitFor(() => expect(screen.getByText(/768P/)).toBeInTheDocument());
    // The aborted "all" request must not surface as a user-facing error.
    expect(screen.queryByText(/Failed to load jobs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/1080P/)).not.toBeInTheDocument();
  });
});

describe('JobDetail retry (per-attempt Idempotency-Key token)', () => {
  function renderDetail(jobId: string) {
    return render(
      <NavProvider>
        <JobDetail jobId={jobId} />
      </NavProvider>,
    );
  }

  beforeEach(() => {
    listJobs.mockReset();
    getJob.mockReset();
    retryJob.mockReset();
    goSpy.mockReset();
  });

  it('sends a per-attempt token and retains it across a failed outcome (resend reuses it)', async () => {
    getJob.mockResolvedValue(makeJob({ id: 'j1', status: 'failed' }));
    retryJob.mockRejectedValue(
      new ApiClientError({
        code: 'internal_error',
        message: 'boom',
        status: 500,
        requestId: 'r1',
      }),
    );
    const user = userEvent.setup();
    renderDetail('j1');
    const btn = await screen.findByRole('button', { name: /Retry as new job/i });

    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(1));
    const token1 = retryJob.mock.calls[0]![1];
    expect(token1).toBeTruthy();
    // The failure surfaces and the component stays on the (still-failed) job.
    await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());

    // A second click reuses the SAME token (outcome was unknown → retained).
    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(2));
    expect(retryJob.mock.calls[1]![1]).toBe(token1);
  });

  it('navigates to a fresh (non-reused) retried job', async () => {
    getJob.mockResolvedValue(makeJob({ id: 'j1', status: 'failed' }));
    retryJob.mockResolvedValue({ job: makeJob({ id: 'j2', status: 'queued' }), reused: false });
    const user = userEvent.setup();
    renderDetail('j1');
    const btn = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(1));
    // A fresh (non-reused) retry navigates to the new job's detail view.
    await waitFor(() =>
      expect(goSpy).toHaveBeenCalledWith({ name: 'job', jobId: 'j2' }),
    );
  });

  it('does not silently navigate to a stale terminal reused job', async () => {
    getJob.mockResolvedValue(makeJob({ id: 'j1', status: 'failed' }));
    // The retry returns a reused job that is ALREADY terminal (stale).
    retryJob.mockResolvedValue({ job: makeJob({ id: 'old-retry', status: 'failed' }), reused: true });
    const user = userEvent.setup();
    renderDetail('j1');
    const btn = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btn);
    // Instead of navigating to the stale failed job, it surfaces a message and
    // stays on the current job (no navigation; the retry button is still present).
    await waitFor(() => expect(screen.getByText(/already finished/i)).toBeInTheDocument());
    expect(goSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Retry as new job/i })).toBeInTheDocument();
  });

  it('resets the retry token when the same instance navigates from job A to job B', async () => {
    // getJob resolves a failed job for whichever id is requested.
    getJob.mockImplementation((id: string) =>
      Promise.resolve(makeJob({ id, status: 'failed' })),
    );
    // The retry outcome is unknown (rejected), so the token is RETAINED for the
    // current job — this is the precondition that makes a stale-token leak
    // possible across a jobId change.
    retryJob.mockRejectedValue(
      new ApiClientError({
        code: 'internal_error',
        message: 'boom',
        status: 500,
        requestId: 'r',
      }),
    );
    const user = userEvent.setup();

    // Render the SAME mounted instance for failed job A and retry it.
    const { rerender } = renderDetail('job-A');
    let btn = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(1));
    const tokenA = retryJob.mock.calls[0]![1];
    expect(tokenA).toBeTruthy();

    // Navigate the SAME mounted instance to failed job B (deep-link / history),
    // NOT a fresh mount. The retained token from A must not leak to B's first
    // retry, or the server returns a payload-hash idempotency conflict.
    rerender(
      <NavProvider>
        <JobDetail jobId="job-B" />
      </NavProvider>,
    );
    // Wait until job B has loaded and rendered so the retry reflects B and the
    // token-reset effect has settled.
    await waitFor(() => expect(screen.getByText('job-B')).toBeInTheDocument());
    btn = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(2));
    const tokenB = retryJob.mock.calls[1]![1];
    expect(tokenB).toBeTruthy();
    // The first retry token for B differs from A's retained token.
    expect(tokenB).not.toBe(tokenA);
    // Sanity: the second retry targeted job B.
    expect(retryJob.mock.calls[1]![0]).toBe('job-B');
  });

  it('retains job A\'s retry token across A→B→A after an unknown/failed A outcome', async () => {
    // getJob resolves a failed job for whichever id is requested.
    getJob.mockImplementation((id: string) =>
      Promise.resolve(makeJob({ id, status: 'failed' })),
    );
    // A's first retry outcome is UNKNOWN (rejected), so A's token must be
    // RETAINED. Returning to A must reuse it — NOT mint a fresh token (a fresh
    // token would create a SECOND paid provider job on the server).
    retryJob.mockRejectedValue(
      new ApiClientError({
        code: 'internal_error',
        message: 'boom',
        status: 500,
        requestId: 'r',
      }),
    );
    const user = userEvent.setup();

    // Render the SAME mounted instance for failed job A and retry it.
    const { rerender } = renderDetail('job-A');
    let btn = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(1));
    const tokenA = retryJob.mock.calls[0]![1];
    expect(tokenA).toBeTruthy();

    // Navigate A→B, then B→A, on the SAME mounted instance (deep-link / history).
    rerender(
      <NavProvider>
        <JobDetail jobId="job-B" />
      </NavProvider>,
    );
    await waitFor(() => expect(screen.getByText('job-B')).toBeInTheDocument());
    rerender(
      <NavProvider>
        <JobDetail jobId="job-A" />
      </NavProvider>,
    );
    await waitFor(() => expect(screen.getByText('job-A')).toBeInTheDocument());

    // Retrying A again must reuse A's RETAINED token (no second paid generation).
    btn = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btn);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(2));
    expect(retryJob.mock.calls[1]![0]).toBe('job-A');
    expect(retryJob.mock.calls[1]![1]).toBe(tokenA);
  });

  it('a late A retry RESULT cannot pollute or navigate the B view', async () => {
    // A's retry resolves LATE (a deferred promise that we settle only after we
    // have navigated away to job B). This simulates a response that was lost and
    // then arrives while a different job is displayed.
    getJob.mockImplementation((id: string) =>
      Promise.resolve(makeJob({ id, status: 'failed' })),
    );
    const aDeferred = createDeferred<{ job: GenerationJob; reused: boolean }>();
    retryJob.mockImplementation((id: string) => {
      if (id === 'job-A') return aDeferred.promise;
      // B's own retry is a normal fresh (non-reused) job.
      return Promise.resolve({ job: makeJob({ id: 'job-B-new', status: 'queued' }), reused: false });
    });
    const user = userEvent.setup();

    const { rerender } = renderDetail('job-A');
    const btnA = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btnA);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(1));
    const tokenA = retryJob.mock.calls[0]![1];

    // Navigate to B while A's retry is still pending. B loads and renders.
    rerender(
      <NavProvider>
        <JobDetail jobId="job-B" />
      </NavProvider>,
    );
    await waitFor(() => expect(screen.getByText('job-B')).toBeInTheDocument());

    // Now A's late RESULT arrives (B is current). It must NOT navigate to A's new
    // job, must NOT surface anything on the B view, and must NOT disable B.
    aDeferred.resolve({ job: makeJob({ id: 'job-A-new', status: 'queued' }), reused: false });
    // Let any (incorrect) pending state updates flush.
    await waitFor(() =>
      expect(screen.queryByText(/job-A-new/i)).not.toBeInTheDocument(),
    );
    expect(goSpy).not.toHaveBeenCalledWith({ name: 'job', jobId: 'job-A-new' });
    expect(goSpy).not.toHaveBeenCalled();
    // The B view is intact and interactive.
    expect(screen.getByText('job-B')).toBeInTheDocument();
    const btnB = await screen.findByRole('button', { name: /Retry as new job/i });
    expect(btnB).not.toBeDisabled();

    // B's own retry uses B's OWN token (never A's) and navigates to B's job.
    await user.click(btnB);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(2));
    expect(retryJob.mock.calls[1]![0]).toBe('job-B');
    const tokenB = retryJob.mock.calls[1]![1];
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);
    await waitFor(() =>
      expect(goSpy).toHaveBeenCalledWith({ name: 'job', jobId: 'job-B-new' }),
    );
  });

  it('a late A retry ERROR cannot pollute the B view', async () => {
    getJob.mockImplementation((id: string) =>
      Promise.resolve(makeJob({ id, status: 'failed' })),
    );
    const aDeferred = createDeferred<{ job: GenerationJob; reused: boolean }>();
    retryJob.mockImplementation((id: string) => {
      if (id === 'job-A') return aDeferred.promise;
      return Promise.resolve({ job: makeJob({ id: 'job-B-new', status: 'queued' }), reused: false });
    });
    const user = userEvent.setup();

    const { rerender } = renderDetail('job-A');
    const btnA = await screen.findByRole('button', { name: /Retry as new job/i });
    await user.click(btnA);
    await waitFor(() => expect(retryJob).toHaveBeenCalledTimes(1));

    rerender(
      <NavProvider>
        <JobDetail jobId="job-B" />
      </NavProvider>,
    );
    await waitFor(() => expect(screen.getByText('job-B')).toBeInTheDocument());

    // A's late ERROR arrives while B is current. B must NOT show A's error and
    // must NOT navigate. A's token is retained (cache untouched on error).
    aDeferred.reject(
      new ApiClientError({
        code: 'internal_error',
        message: 'A-only-failure',
        status: 500,
        requestId: 'rA',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/A-only-failure/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByText('job-B')).toBeInTheDocument();
    expect(goSpy).not.toHaveBeenCalled();
  });
});
