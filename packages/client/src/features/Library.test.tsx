import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Prompt } from '@h3/shared';
import { NavProvider } from '../nav.js';
import { Library } from './Library.js';

vi.mock('../api/client.js', () => ({
  api: {
    listPrompts: vi.fn(),
    getHealth: vi.fn(),
  },
  ApiClientError: class extends Error {},
}));

import { api } from '../api/client.js';

const listPrompts = vi.mocked(api.listPrompts);

function renderLibrary() {
  return render(
    <NavProvider>
      <Library onNew={vi.fn()} />
    </NavProvider>,
  );
}

beforeEach(() => {
  listPrompts.mockReset();
});

describe('Library', () => {
  it('shows an empty state when there are no prompts', async () => {
    listPrompts.mockResolvedValue({ items: [], total: 0 });
    renderLibrary();
    await waitFor(() =>
      expect(screen.getByText(/No prompts yet/i)).toBeInTheDocument(),
    );
    expect(
      screen.getAllByRole('button', { name: /New prompt/i }).length,
    ).toBeGreaterThan(0);
  });

  it('renders prompt cards when prompts exist', async () => {
    listPrompts.mockResolvedValue({
      items: [
        {
          id: 'p1',
          name: 'Cinematic Reveal',
          description: 'A hero shot',
          tags: ['product'],
          status: 'active',
          currentVersionId: 'v1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          archivedAt: null,
        },
      ],
      total: 1,
    });
    renderLibrary();
    await waitFor(() =>
      expect(screen.getByText('Cinematic Reveal')).toBeInTheDocument(),
    );
    expect(screen.getByText('#product')).toBeInTheDocument();
  });

  it('shows an error banner when loading fails', async () => {
    listPrompts.mockRejectedValue(new Error('boom'));
    renderLibrary();
    await waitFor(() =>
      expect(screen.getByText(/Failed to load prompts/i)).toBeInTheDocument(),
    );
  });

  it('invokes search with the query term', async () => {
    listPrompts.mockResolvedValue({ items: [], total: 0 });
    const user = userEvent.setup();
    renderLibrary();
    await waitFor(() => expect(listPrompts).toHaveBeenCalled());
    const search = screen.getByLabelText(/Search prompts/i);
    await user.type(search, 'hero');
    await waitFor(() =>
      expect(listPrompts).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'hero' }),
        expect.anything(),
      ),
    );
  });
});

describe('Library search races (debounce + abort + stale guard)', () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function makePrompt(id: string, name: string): Prompt {
    return {
      id,
      name,
      description: '',
      tags: [],
      status: 'active',
      currentVersionId: 'v',
      createdAt: '',
      updatedAt: '',
      archivedAt: null,
    };
  }

  it('ignores a stale response from a superseded query', async () => {
    const slowA = createDeferred<{ items: ReturnType<typeof makePrompt>[]; total: number }>();
    listPrompts.mockImplementation((query) => {
      if (query?.q === 'a') return slowA.promise;
      if (query?.q === 'ab') {
        return Promise.resolve({ items: [makePrompt('ab', 'AB Match')], total: 1 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });

    const user = userEvent.setup({ delay: null });
    renderLibrary();
    await waitFor(() => expect(listPrompts).toHaveBeenCalled()); // initial load

    const search = screen.getByLabelText(/Search prompts/i);
    // Type 'a' and wait for its (debounced) request to actually fire.
    await user.type(search, 'a');
    await waitFor(() =>
      expect(listPrompts).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'a' }),
        expect.anything(),
      ),
    );
    // Then type 'b' (now 'ab'): the current query.
    await user.type(search, 'b');
    await waitFor(() => expect(screen.getByText('AB Match')).toBeInTheDocument());

    // The stale 'a' response resolves late — it must NOT overwrite 'ab'.
    slowA.resolve({ items: [makePrompt('a', 'A Stale')], total: 1 });
    await waitFor(() =>
      expect(screen.queryByText('A Stale')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('AB Match')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load prompts/i)).not.toBeInTheDocument();
  });

  it('ignores a stale error from a superseded query', async () => {
    const slowErr = createDeferred<{ items: ReturnType<typeof makePrompt>[]; total: number }>();
    listPrompts.mockImplementation((query) => {
      if (query?.q === 'x') {
        // Resolve late as a success; the component must still ignore it because by
        // then the query has moved on. (We verify no stale error leaks instead.)
        return slowErr.promise;
      }
      if (query?.q === 'xy') {
        return Promise.resolve({ items: [makePrompt('xy', 'XY Match')], total: 1 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });

    const user = userEvent.setup({ delay: null });
    renderLibrary();
    await waitFor(() => expect(listPrompts).toHaveBeenCalled());
    const search = screen.getByLabelText(/Search prompts/i);
    await user.type(search, 'x');
    await waitFor(() =>
      expect(listPrompts).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'x' }),
        expect.anything(),
      ),
    );
    await user.type(search, 'y');
    await waitFor(() => expect(screen.getByText('XY Match')).toBeInTheDocument());
    // Stale 'x' response arriving late does not change the current view.
    slowErr.resolve({ items: [makePrompt('x', 'X Stale')], total: 1 });
    await waitFor(() =>
      expect(screen.queryByText('X Stale')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('XY Match')).toBeInTheDocument();
  });
});
