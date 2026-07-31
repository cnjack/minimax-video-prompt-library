import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  // Mirror the real ApiClientError: constructed from an error body and exposing
  // the stable code/status/requestId used by the component.
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

describe('Composer camera-movement preset chips', () => {
  it('renders the six presets as keyboard-reachable buttons with names', async () => {
    renderComposer();
    await waitFor(() => expect(screen.getByLabelText('subject')).toBeInTheDocument());

    const group = screen.getByRole('group', { name: /camera movement presets/i });
    const chips = within(group).getAllByRole('button');
    expect(chips).toHaveLength(6);
    // Each chip is a real <button> (keyboard reachable) with a meaningful name.
    expect(chips.map((c) => c.textContent)).toEqual([
      'Pan left',
      'Pan right',
      'Push in',
      'Pull out',
      'Tracking shot',
      'Static shot',
    ]);
    for (const chip of chips) {
      expect(chip.tagName).toBe('BUTTON');
      expect(chip).toHaveAttribute('type', 'button');
    }
  });

  it('appends a camera cue at the end when the cursor has not been placed', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(await screen.findByLabelText('subject'), 'a car');
    await user.click(screen.getByRole('button', { name: 'Pan left' }));

    const prompt = screen.getByLabelText('Rendered prompt') as HTMLTextAreaElement;
    expect(prompt.value).toBe('A film of a car pan left');
  });

  it('inserts a camera cue at the cursor in the middle of the prompt', async () => {
    renderComposer();
    await userEvent.type(await screen.findByLabelText('subject'), 'a car');

    const prompt = screen.getByLabelText('Rendered prompt') as HTMLTextAreaElement;
    prompt.focus();
    prompt.setSelectionRange(6, 6); // caret after "A film"
    fireEvent.click(screen.getByRole('button', { name: 'Tracking shot' }));

    expect(prompt.value).toBe('A film tracking shot of a car');
  });

  it('replaces the current selection with the camera cue', async () => {
    renderComposer();
    await userEvent.type(await screen.findByLabelText('subject'), 'a car');

    const prompt = screen.getByLabelText('Rendered prompt') as HTMLTextAreaElement;
    prompt.focus();
    prompt.setSelectionRange(0, 6); // select "A film"
    fireEvent.click(screen.getByRole('button', { name: 'Static shot' }));

    expect(prompt.value).toBe('static shot of a car');
  });

  it('preserves surrounding text across multiple consecutive cues', async () => {
    renderComposer();
    await userEvent.type(await screen.findByLabelText('subject'), 'a car');

    const prompt = screen.getByLabelText('Rendered prompt') as HTMLTextAreaElement;
    prompt.focus();
    prompt.setSelectionRange(6, 6); // after "A film"
    fireEvent.click(screen.getByRole('button', { name: 'Pan left' }));
    // After an insert the caret sits right after the inserted token, so a second
    // cue is added directly after it without clobbering the rest of the prompt.
    fireEvent.click(screen.getByRole('button', { name: 'Push in' }));

    expect(prompt.value).toBe('A film pan left push in of a car');
  });

  it('sends the cue-augmented prompt as the generated prompt', async () => {
    const user = userEvent.setup();
    createGeneration.mockResolvedValue({ job: { id: 'job-1' }, reused: false });
    renderComposer();
    await user.type(await screen.findByLabelText('subject'), 'a car');
    await user.click(screen.getByRole('button', { name: 'Push in' }));
    await user.click(screen.getByRole('button', { name: /Generate video/i }));

    await waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1));
    const payload = createGeneration.mock.calls[0]![0] as { prompt: string };
    expect(payload.prompt).toBe('A film of a car push in');
  });

  it('reset restores the freshly rendered prompt', async () => {
    renderComposer();
    await userEvent.type(await screen.findByLabelText('subject'), 'a car');

    fireEvent.click(screen.getByRole('button', { name: 'Pan left' }));
    const prompt = screen.getByLabelText('Rendered prompt') as HTMLTextAreaElement;
    expect(prompt.value).toBe('A film of a car pan left');

    fireEvent.click(screen.getByRole('button', { name: /reset to rendered/i }));
    expect(prompt.value).toBe('A film of a car');
  });
});
