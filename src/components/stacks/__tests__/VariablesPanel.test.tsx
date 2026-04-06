import { describe, it, expect, mock, beforeEach, jest } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockListSecrets = mock(() => Promise.resolve(['DB_URL', 'SECRET_KEY']));
const mockGetSecret = mock((): Promise<string | null> => Promise.resolve('super-secret'));
const mockSetSecret = mock(() => Promise.resolve(undefined));
const mockDeleteSecret = mock(() => Promise.resolve(undefined));
const mockEnsureVariablesExist = mock(() => Promise.resolve(undefined));

const realModule = await import('@/data/stacks/functions');

mock.module('@/data/stacks/functions', () => ({
  ...realModule,
  getStackVariables: mockListSecrets,
  getVariableValue: mockGetSecret,
  setVariableValue: mockSetSecret,
  deleteVariable: mockDeleteSecret,
  ensureVariablesExist: mockEnsureVariablesExist,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function renderPanel(
  stackName = 'mystack',
  composeVariables: string[] = [],
) {
  const { default: VariablesPanel } = await import('../VariablesPanel');
  return render(
    <VariablesPanel stackName={stackName} composeVariables={composeVariables} />,
    { wrapper: createWrapper() },
  );
}

describe('VariablesPanel', () => {
  beforeEach(() => {
    // Restore real timers in case a prior test file left fake timers installed.
    // In bun 1.3.x, fake timer state can leak across files in the same worker,
    // causing @testing-library/dom's jestFakeTimersAreEnabled() check to mismatch:
    // it sees setTimeout._isMockFunction===true but then bun throws "Fake timers
    // are not active" when it tries to advance them. Manually clear both markers.
    jest.useRealTimers();
    delete (setTimeout as unknown as Record<string, unknown>)._isMockFunction;
    delete (setTimeout as unknown as Record<string, unknown>).clock;
    mockListSecrets.mockClear();
    mockGetSecret.mockClear();
    mockSetSecret.mockClear();
    mockDeleteSecret.mockClear();
    mockEnsureVariablesExist.mockClear();
  });

  it('renders loading skeleton while fetching', async () => {
    let resolveVariables!: (v: string[]) => void;
    mockListSecrets.mockImplementationOnce(
      () => new Promise<string[]>((res) => { resolveVariables = res; }),
    );
    const { container } = await renderPanel();
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
    resolveVariables([]);
    await waitFor(() => {
      expect(container.querySelectorAll('.MuiSkeleton-root')).toHaveLength(0);
    });
  });

  it('shows error alert when OpenBao is unreachable', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.reject(new Error('Connection refused')),
    );
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Unable to connect to OpenBao/)).toBeDefined();
    });
  });

  it('renders variable rows from OpenBao data', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.resolve(['DB_URL', 'SECRET_KEY']),
    );
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText('DB_URL')).toBeDefined();
      expect(screen.getByText('SECRET_KEY')).toBeDefined();
    });
  });

  it('renders empty state when OpenBao returns no variables', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve([]));
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText('No variables in OpenBao.')).toBeDefined();
    });
  });

  it('eye icon reveals field and fetches value on first click', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.resolve(['API_TOKEN']),
    );
    mockGetSecret.mockImplementationOnce(() => Promise.resolve('tok_123'));
    await renderPanel();
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    const revealBtn = screen.getByLabelText('Reveal value');
    fireEvent.click(revealBtn);

    await waitFor(() => {
      expect(mockGetSecret).toHaveBeenCalledTimes(1);
    });
  });

  it('second eye click hides value without fetching again', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.resolve(['API_TOKEN']),
    );
    mockGetSecret.mockImplementationOnce(() => Promise.resolve('tok_123'));
    await renderPanel();
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    const revealBtn = screen.getByLabelText('Reveal value');
    fireEvent.click(revealBtn);
    await waitFor(() => expect(mockGetSecret).toHaveBeenCalledTimes(1));

    const hideBtn = screen.getByLabelText('Hide value');
    fireEvent.click(hideBtn);
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });

  it('delete button is disabled with tooltip when variable is referenced in compose', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.resolve(['DB_URL']),
    );
    await renderPanel('mystack', ['DB_URL']);
    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('delete button is enabled when variable is not referenced in compose', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.resolve(['ORPHAN_VAR']),
    );
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('ORPHAN_VAR')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens delete confirmation dialog when delete is clicked', async () => {
    mockListSecrets.mockImplementationOnce(() =>
      Promise.resolve(['OLD_VAR']),
    );
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      // Heading is the dialog title; text about "cannot be undone" is in the body
      expect(screen.getByRole('heading', { name: 'Delete variable' })).toBeDefined();
      expect(screen.getByText(/This cannot be undone/)).toBeDefined();
    });
  });

  it('calls deleteVariable and refreshes after confirming delete', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['TEMP_VAR']));
    mockDeleteSecret.mockImplementationOnce(() => Promise.resolve(undefined));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('TEMP_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(mockDeleteSecret).toHaveBeenCalledTimes(1));
  });

  it('calls deleteVariable mutation and invokes onDeleted callback on success', async () => {
    // First call: list with the variable; second call: list after invalidation (variable gone)
    mockListSecrets
      .mockImplementationOnce(() => Promise.resolve(['TEMP_VAR']))
      .mockImplementationOnce(() => Promise.resolve([]));
    mockDeleteSecret.mockImplementationOnce(() => Promise.resolve(undefined));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('TEMP_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteSecret).toHaveBeenCalledTimes(1);
      // onDeleted triggers invalidateQueries which triggers a re-fetch
      expect(mockListSecrets).toHaveBeenCalledTimes(2);
    });
  });

  it('does not call deleteVariable when Cancel is clicked in the dialog', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['OLD_VAR']));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  it('saves variable value and marks field as clean on success', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['API_KEY']));
    mockGetSecret.mockImplementationOnce(() => Promise.resolve('original-value'));
    mockSetSecret.mockImplementationOnce(() => Promise.resolve(undefined));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_KEY')).toBeDefined());

    // Reveal the field to fetch the value
    fireEvent.click(screen.getByLabelText('Reveal value'));
    await waitFor(() => expect(mockGetSecret).toHaveBeenCalledTimes(1));

    // Modify the value to make the field dirty
    const input = screen.getByDisplayValue('original-value');
    fireEvent.change(input, { target: { value: 'new-value' } });

    // Save button should now be enabled
    const saveBtn = screen.getByLabelText('Save value');
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(saveBtn);

    await waitFor(() => expect(mockSetSecret).toHaveBeenCalledTimes(1));

    // After save, field should no longer be dirty (save button disabled again)
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(true));
  });

  it('calls ensureVariablesExist when compose variables are missing from OpenBao', async () => {
    // OpenBao only has DB_URL, but compose references DB_URL and NEW_VAR
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['DB_URL']));
    mockEnsureVariablesExist.mockImplementationOnce(() => Promise.resolve(undefined));
    // After invalidation, return all variables
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['DB_URL', 'NEW_VAR']));

    await renderPanel('mystack', ['DB_URL', 'NEW_VAR']);

    await waitFor(() => {
      expect(mockEnsureVariablesExist).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call ensureVariablesExist when all compose variables already exist in OpenBao', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['DB_URL', 'SECRET_KEY']));

    await renderPanel('mystack', ['DB_URL', 'SECRET_KEY']);

    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    expect(mockEnsureVariablesExist).not.toHaveBeenCalled();
  });

  it('silently catches error when ensureVariablesExist rejects', async () => {
    // OpenBao has DB_URL but compose also references NEW_VAR — triggers ensureVariablesExist
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['DB_URL']));
    mockEnsureVariablesExist.mockImplementationOnce(() => Promise.reject(new Error('OpenBao unreachable')));

    await renderPanel('mystack', ['DB_URL', 'NEW_VAR']);

    await waitFor(() => {
      expect(mockEnsureVariablesExist).toHaveBeenCalledTimes(1);
    });
    // The catch callback silences the error — no throw, no error UI for this path
  });

  it('save button is disabled when field has not been fetched yet', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['API_TOKEN']));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    const saveBtn = screen.getByLabelText('Save value');
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows inline error when fetchValue mutation fails', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['API_TOKEN']));
    mockGetSecret.mockImplementationOnce(() =>
      Promise.reject(new Error('OpenBao connection refused')),
    );

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Reveal value'));

    await waitFor(() => {
      expect(screen.getByText('Failed to retrieve value from OpenBao.')).toBeDefined();
    });
  });

  it('clears fetch error on retry', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['API_TOKEN']));
    mockGetSecret
      .mockImplementationOnce(() => Promise.reject(new Error('Timeout')))
      .mockImplementationOnce(() => Promise.resolve('recovered'));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    // First click fails
    fireEvent.click(screen.getByLabelText('Reveal value'));
    await waitFor(() => {
      expect(screen.getByText('Failed to retrieve value from OpenBao.')).toBeDefined();
    });

    // Hide then reveal again — retry should clear the error
    fireEvent.click(screen.getByLabelText('Hide value'));
    fireEvent.click(screen.getByLabelText('Reveal value'));
    await waitFor(() => {
      expect(screen.queryByText('Failed to retrieve value from OpenBao.')).toBeNull();
    });
  });

  it('shows inline error when save mutation fails', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['API_KEY']));
    mockGetSecret.mockImplementationOnce(() => Promise.resolve('original'));
    mockSetSecret.mockImplementationOnce(() =>
      Promise.reject(new Error('OpenBao write failed')),
    );

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_KEY')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Reveal value'));
    await waitFor(() => expect(mockGetSecret).toHaveBeenCalledTimes(1));

    const input = screen.getByDisplayValue('original');
    fireEvent.change(input, { target: { value: 'changed' } });

    const saveBtn = screen.getByLabelText('Save value');
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText('Failed to save value to OpenBao.')).toBeDefined();
    });
  });

  it('shows error inside delete dialog when delete mutation fails', async () => {
    mockListSecrets.mockImplementationOnce(() => Promise.resolve(['OLD_VAR']));
    mockDeleteSecret.mockImplementationOnce(() =>
      Promise.reject(new Error('OpenBao delete failed')),
    );

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to delete variable from OpenBao.')).toBeDefined();
    });
    // Dialog stays open so user can retry
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});
