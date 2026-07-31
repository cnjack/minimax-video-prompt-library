import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GenerationJob } from '@h3/shared';
import { NavProvider } from '../nav.js';
import { JobsList } from './Jobs.js';

vi.mock('../api/client.js', () => ({
  api: { listJobs: vi.fn() },
  ApiClientError: class extends Error {},
}));

import { api } from '../api/client.js';

const listJobs = vi.mocked(api.listJobs);

function makeJob(o: Partial<GenerationJob> & { id: string }): GenerationJob {
  const defaults: GenerationJob = {
    id: 'default',
    promptId: 'p1',
    promptVersionId: 'v1',
    renderedPrompt: 'x',
    model: 'MiniMax-H3',
    durationSeconds: 5,
    aspectRatio: '16:9',
    resolution: '2K',
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

const allJob = makeJob({ id: 'all-1', aspectRatio: '21:9' });
const failedJob = makeJob({ id: 'failed-1', status: 'failed', aspectRatio: '9:16' });

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
    await waitFor(() => expect(screen.getByText(/21:9/)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText(/9:16/)).toBeInTheDocument());

    // Now the stale "all" response arrives. It must NOT overwrite "failed".
    allDeferred.resolve({ items: [allJob], total: 1 });
    await waitFor(() => {
      expect(screen.queryByText(/21:9/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/9:16/)).toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByText(/9:16/)).toBeInTheDocument());
    // The aborted "all" request must not surface as a user-facing error.
    expect(screen.queryByText(/Failed to load jobs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/21:9/)).not.toBeInTheDocument();
  });
});
