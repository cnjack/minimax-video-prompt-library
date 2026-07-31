/**
 * Deterministic mock provider. Produces realistic, repeatable state transitions
 * (queued → running → succeeded/failed/expired) with no network and no
 * credentials. The active scenario defaults to "success" and can be changed at
 * runtime through the mock-only debug endpoint, or per request via
 * `CreateJobInput.mockScenario`.
 *
 * State is held in-process for this single-instance PoC; an unknown task id
 * (e.g. after a restart) resolves deterministically to a terminal state so the
 * poller never spins forever.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ProviderErrorCategory } from '@h3/shared';
import { ProviderError } from './types.js';
import type {
  CreateJobInput,
  CreateJobOutput,
  MockScenario,
  ProviderFailure,
  QueryJobOutput,
  VideoProvider,
} from './types.js';

interface MockTask {
  scenario: MockScenario;
  queries: number;
  renderedPrompt: string;
}

const FAILURE_BY_SCENARIO: Record<'failure' | 'expired', ProviderFailure> = {
  failure: {
    category: ProviderErrorCategory.CONTENT_MODERATION,
    message: 'Mock: generated content flagged by safety review.',
  },
  expired: {
    category: ProviderErrorCategory.PROVIDER_FAILURE,
    message: 'Mock: task expired before completion.',
  },
};

/** Returns the local status for a scenario after `queries` poll calls. */
function nextState(
  scenario: MockScenario,
  queries: number,
): 'queued' | 'running' | 'done' {
  // First query always advances from queued to running for non-error scenarios.
  if (queries === 1) {
    return 'running';
  }
  switch (scenario) {
    case 'success':
      return queries >= 2 ? 'done' : 'running';
    case 'slow':
      return queries >= 4 ? 'done' : 'running';
    case 'failure':
      return queries >= 2 ? 'done' : 'running';
    case 'expired':
      return queries >= 2 ? 'done' : 'running';
    case 'provider_error':
      return 'done';
  }
}

function deterministicResultUrl(renderedPrompt: string): string {
  const hash = createHash('sha1').update(renderedPrompt).digest('hex').slice(0, 16);
  return `https://mock.minimax.local/video/${hash}.mp4`;
}

export class MockProvider implements VideoProvider {
  readonly name = 'mock' as const;
  readonly configured = true;

  private readonly tasks = new Map<string, MockTask>();
  private counter = 0;
  private defaultScenario: MockScenario = 'success';
  /**
   * Per-instance collision-resistant prefix. A fresh process/instance generates a
   * new prefix, so task ids can never collide with task ids persisted by a
   * previous (restarted) instance. This prevents an old persisted non-terminal
   * job from polling a brand-new in-memory task and receiving the wrong result.
   * State transitions and result URLs remain fully deterministic.
   */
  private readonly instancePrefix: string = randomUUID().slice(0, 8);

  /** Set the default scenario used for new mock jobs (mock-only endpoint). */
  setDefaultScenario(scenario: MockScenario): void {
    this.defaultScenario = scenario;
  }

  getDefaultScenario(): MockScenario {
    return this.defaultScenario;
  }

  /** Clear in-memory task state (test helper). */
  reset(): void {
    this.tasks.clear();
    this.counter = 0;
    this.defaultScenario = 'success';
  }

  async create(input: CreateJobInput): Promise<CreateJobOutput> {
    const scenario = input.mockScenario ?? this.defaultScenario;
    if (scenario === 'provider_error') {
      throw new ProviderError(
        ProviderErrorCategory.AUTH,
        'Mock: invalid or missing MiniMax credentials (provider_error scenario).',
        401,
      );
    }
    const providerTaskId = `mock-task-${this.instancePrefix}-${++this.counter}`;
    this.tasks.set(providerTaskId, {
      scenario,
      queries: 0,
      renderedPrompt: input.renderedPrompt,
    });
    return { providerTaskId, status: 'queued' };
  }

  async query(providerTaskId: string): Promise<QueryJobOutput> {
    const task = this.tasks.get(providerTaskId);
    if (!task) {
      // State lost (e.g. restart): resolve deterministically to terminate.
      return {
        providerTaskId,
        status: 'failed',
        failure: {
          category: ProviderErrorCategory.PROVIDER_FAILURE,
          message: 'Mock task state is unavailable (server restarted).',
        },
      };
    }

    task.queries += 1;
    const phase = nextState(task.scenario, task.queries);

    if (phase === 'running') {
      return { providerTaskId, status: 'running' };
    }

    if (task.scenario === 'success' || task.scenario === 'slow') {
      return {
        providerTaskId,
        status: 'succeeded',
        resultUrl: deterministicResultUrl(task.renderedPrompt),
      };
    }
    if (task.scenario === 'expired') {
      return {
        providerTaskId,
        status: 'expired',
        failure: FAILURE_BY_SCENARIO.expired,
      };
    }
    return {
      providerTaskId,
      status: 'failed',
      failure: FAILURE_BY_SCENARIO.failure,
    };
  }
}
