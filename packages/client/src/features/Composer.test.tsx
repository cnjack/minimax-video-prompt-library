import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavProvider } from '../nav.js';
import { Composer } from './Composer.js';

const getPrompt = vi.fn();
const createGeneration = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getPrompt: (...args: unknown[]) => getPrompt(...args),
    createGeneration: (...args: unknown[]) => createGeneration(...args),
  },
  ApiClientError: class extends Error {
    constructor(message: string) {
      super(message);
    }
  },
}));

import type { PromptDetail } from '@h3/shared';
import { ApiClientError } from '../api/client.js';

function versionDetail(): PromptDetail {
  return {
    prompt: {
      id: 'p1',
      name: 'P',
      description: '',
      tags: [],
      status: 'active',
      currentVersionId: 'v1',
      createdAt: '',
      updatedAt: '',
      archivedAt: null,
    },
    versions: [
      {
        id: 'v1',
        promptId: 'p1',
        versionNumber: 1,
        content: 'A film of {{subject}}',
        variables: ['subject'],
        createdAt: '',
      },
    ],
  };
}

function renderComposer() {
  return render(
    <NavProvider>
      <Composer promptId="p1" versionId="v1" mode="mock" />
    </NavProvider>,
  );
}

beforeEach(() => {
  getPrompt.mockReset();
  createGeneration.mockReset();
  getPrompt.mockResolvedValue(versionDetail());
});

describe('Composer', () => {
  it('disables submit and warns while a variable is missing', async () => {
    renderComposer();
    await waitFor(() => expect(screen.getByLabelText('subject')).toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: /Generate video/i }),
    ).toBeDisabled();
    expect(screen.getByText(/Fill in all variables: subject/i)).toBeInTheDocument();
  });

  it('enables submit once the variable is filled', async () => {
    const user = userEvent.setup();
    renderComposer();
    const field = await screen.findByLabelText('subject');
    await user.type(field, 'a car');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Generate video/i })).toBeEnabled(),
    );
  });

  it('protects against double submission (one createGeneration call)', async () => {
    // Never resolves so the component stays in the submitting state.
    createGeneration.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderComposer();
    await user.type(await screen.findByLabelText('subject'), 'a car');
    const submit = await screen.findByRole('button', { name: /Generate video/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await user.click(submit);
    await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1));
    // The submitted payload carries an idempotency key.
    const payload = createGeneration.mock.calls[0]![0] as { idempotencyKey: string };
    expect(payload.idempotencyKey).toBeTruthy();
  });

  it('renders a provider failure message', async () => {
    createGeneration.mockRejectedValue(
      new ApiClientError({
        code: 'provider_error',
        message: 'Content rejected',
        status: 500,
        requestId: 'rid-test',
      }),
    );
    const user = userEvent.setup();
    renderComposer();
    await user.type(await screen.findByLabelText('subject'), 'a car');
    const submit = await screen.findByRole('button', { name: /Generate video/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    // createGeneration returns the reused job envelope normally; here it rejected.
    await waitFor(() =>
      expect(screen.getByText(/Content rejected/i)).toBeInTheDocument(),
    );
  });
});
