/**
 * In-process job poller for this single-instance PoC.
 *
 * On each tick it loads non-terminal jobs and queries the provider:
 *  - a returned status is applied directly (and resets the failure counter);
 *  - a thrown provider error is counted; after `maxAttempts` consecutive
 *    failures the job is marked terminally failed so polling cannot spin
 *    forever.
 *
 * Polling is idempotent: re-querying and re-applying the same status is a
 * no-op. Only queued/running jobs are ever touched.
 */

import type { AppConfig } from '../config.js';
import type { JobRepository } from '../db/repositories/jobRepo.js';
import type { ProviderError, VideoProvider } from '../providers/types.js';
import { nowIso } from '../util.js';

export class JobPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly provider: VideoProvider,
    private readonly config: AppConfig,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.log('error', `Poller tick crashed: ${stringifyError(error)}`);
      });
    }, this.config.pollIntervalMs);
    this.log('info', `Poller started (interval=${this.config.pollIntervalMs}ms).`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log('info', 'Poller stopped.');
    }
  }

  /** Advance every non-terminal job once. Public so tests can drive it. */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const pending = this.jobs.listNonTerminal();
      for (const job of pending) {
        if (!job.providerTaskId) {
          // No provider task yet (submission failed terminally is already
          // filtered out by listNonTerminal). Skip defensively.
          continue;
        }
        await this.pollOne(job.id, job.providerTaskId);
      }
    } finally {
      this.running = false;
    }
  }

  private async pollOne(jobId: string, providerTaskId: string): Promise<void> {
    try {
      const result = await this.provider.query(providerTaskId);
      this.failures.delete(jobId);
      const update: Parameters<typeof this.jobs.updateStatus>[1] = {
        status: result.status,
        now: nowIso(),
      };
      if (result.resultUrl) {
        update.resultUrl = result.resultUrl;
      }
      if (result.failure) {
        update.errorCode = result.failure.category;
        update.errorMessage = result.failure.message;
      } else if (result.status === 'succeeded') {
        update.errorCode = null;
        update.errorMessage = null;
      }
      const outcome = this.jobs.updateStatus(jobId, update);
      // Compare-and-set: if the row became terminal between the poll listing
      // and this update, a non-terminal result (e.g. a stale "running") was
      // refused. Treat that as a safe no-op rather than reviving a terminal job.
      if (outcome.lostUpdate) {
        this.log(
          'warn',
          `Job ${jobId} was already terminal; ignored stale ${result.status} poll update.`,
        );
      }
    } catch (error) {
      const attempts = (this.failures.get(jobId) ?? 0) + 1;
      this.failures.set(jobId, attempts);
      const category =
        error instanceof Error && 'category' in error
          ? (error as ProviderError).category
          : 'provider_failure';
      const message =
        error instanceof Error ? error.message : 'Unknown polling error.';

      if (attempts >= this.config.pollMaxAttempts) {
        // Bounded budget exhausted: a recoverable-stalled outcome, NOT a genuine
        // terminal failure. The provider task is still assumed alive; only a
        // Resume (re-polling the SAME stored task id, no paid create) can move
        // this row forward. Genuine provider `Fail` is applied above as a real
        // terminal `failed` and never reaches this branch.
        this.failures.delete(jobId);
        this.jobs.updateStatus(jobId, {
          status: 'tracking_exhausted',
          errorCode: category,
          errorMessage: `Tracking paused: the provider read path failed ${attempts} consecutive times (${category}). Resume to keep polling the same provider task.`,
          now: nowIso(),
        });
        this.log(
          'warn',
          `Job ${jobId} tracking-exhausted after ${attempts} transient poll failures; resumable.`,
        );
      } else {
        this.log('warn', `Job ${jobId} poll failure ${attempts}: ${message}`);
      }
    }
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
