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
      this.jobs.updateStatus(jobId, update);
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
        this.failures.delete(jobId);
        this.jobs.updateStatus(jobId, {
          status: 'failed',
          errorCode: category,
          errorMessage: `Polling gave up after ${attempts} attempts: ${message}`,
          now: nowIso(),
        });
        this.log('warn', `Job ${jobId} marked failed after ${attempts} poll failures.`);
      } else {
        this.log('warn', `Job ${jobId} poll failure ${attempts}: ${message}`);
      }
    }
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
