import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      expect(listPrompts).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'hero' })),
    );
  });
});
