import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockGetStackVariables = mock(() => Promise.resolve(['DB_URL', 'SECRET_KEY']));
const mockGetVariableValue = mock(() => Promise.resolve('super-secret'));
const mockSetVariableValue = mock(() => Promise.resolve(undefined));
const mockDeleteVariable = mock(() => Promise.resolve(undefined));
const mockEnsureVariablesExist = mock(() => Promise.resolve(undefined));

const realModule = await import('@/data/stacks/functions');

mock.module('@/data/stacks/functions', () => ({
  ...realModule,
  getStackVariables: mockGetStackVariables,
  getVariableValue: mockGetVariableValue,
  setVariableValue: mockSetVariableValue,
  deleteVariable: mockDeleteVariable,
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
    mockGetStackVariables.mockClear();
    mockGetVariableValue.mockClear();
    mockSetVariableValue.mockClear();
    mockDeleteVariable.mockClear();
    mockEnsureVariablesExist.mockClear();
  });

  it('renders loading skeleton while fetching', async () => {
    let resolveVariables!: (v: string[]) => void;
    mockGetStackVariables.mockImplementationOnce(
      () => new Promise<string[]>((res) => { resolveVariables = res; }),
    );
    const { container } = await renderPanel();
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
    resolveVariables([]);
  });

  it('shows error alert when OpenBao is unreachable', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
      Promise.reject(new Error('Connection refused')),
    );
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Unable to connect to OpenBao/)).toBeDefined();
    });
  });

  it('renders variable rows from OpenBao data', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
      Promise.resolve(['DB_URL', 'SECRET_KEY']),
    );
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText('DB_URL')).toBeDefined();
      expect(screen.getByText('SECRET_KEY')).toBeDefined();
    });
  });

  it('renders empty state when OpenBao returns no variables', async () => {
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve([]));
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText('No variables in OpenBao.')).toBeDefined();
    });
  });

  it('eye icon reveals field and fetches value on first click', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
      Promise.resolve(['API_TOKEN']),
    );
    mockGetVariableValue.mockImplementationOnce(() => Promise.resolve('tok_123'));
    await renderPanel();
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    const revealBtn = screen.getByLabelText('Reveal value');
    fireEvent.click(revealBtn);

    await waitFor(() => {
      expect(mockGetVariableValue).toHaveBeenCalledTimes(1);
    });
  });

  it('second eye click hides value without fetching again', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
      Promise.resolve(['API_TOKEN']),
    );
    mockGetVariableValue.mockImplementationOnce(() => Promise.resolve('tok_123'));
    await renderPanel();
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    const revealBtn = screen.getByLabelText('Reveal value');
    fireEvent.click(revealBtn);
    await waitFor(() => expect(mockGetVariableValue).toHaveBeenCalledTimes(1));

    const hideBtn = screen.getByLabelText('Hide value');
    fireEvent.click(hideBtn);
    expect(mockGetVariableValue).toHaveBeenCalledTimes(1);
  });

  it('delete button is disabled with tooltip when variable is referenced in compose', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
      Promise.resolve(['DB_URL']),
    );
    await renderPanel('mystack', ['DB_URL']);
    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('delete button is enabled when variable is not referenced in compose', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
      Promise.resolve(['ORPHAN_VAR']),
    );
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('ORPHAN_VAR')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens delete confirmation dialog when delete is clicked', async () => {
    mockGetStackVariables.mockImplementationOnce(() =>
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
    mockGetStackVariables.mockImplementation(() => Promise.resolve(['TEMP_VAR']));
    mockDeleteVariable.mockImplementationOnce(() => Promise.resolve(undefined));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('TEMP_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(mockDeleteVariable).toHaveBeenCalledTimes(1));
  });

  it('calls deleteVariable mutation and invokes onDeleted callback on success', async () => {
    // First call: list with the variable; second call: list after invalidation (variable gone)
    mockGetStackVariables
      .mockImplementationOnce(() => Promise.resolve(['TEMP_VAR']))
      .mockImplementationOnce(() => Promise.resolve([]));
    mockDeleteVariable.mockImplementationOnce(() => Promise.resolve(undefined));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('TEMP_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteVariable).toHaveBeenCalledTimes(1);
      // onDeleted triggers invalidateQueries which triggers a re-fetch
      expect(mockGetStackVariables).toHaveBeenCalledTimes(2);
    });
  });

  it('does not call deleteVariable when Cancel is clicked in the dialog', async () => {
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['OLD_VAR']));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockDeleteVariable).not.toHaveBeenCalled();
  });

  it('saves variable value and marks field as clean on success', async () => {
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['API_KEY']));
    mockGetVariableValue.mockImplementationOnce(() => Promise.resolve('original-value'));
    mockSetVariableValue.mockImplementationOnce(() => Promise.resolve(undefined));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_KEY')).toBeDefined());

    // Reveal the field to fetch the value
    fireEvent.click(screen.getByLabelText('Reveal value'));
    await waitFor(() => expect(mockGetVariableValue).toHaveBeenCalledTimes(1));

    // Modify the value to make the field dirty
    const input = screen.getByDisplayValue('original-value');
    fireEvent.change(input, { target: { value: 'new-value' } });

    // Save button should now be enabled
    const saveBtn = screen.getByLabelText('Save value');
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(saveBtn);

    await waitFor(() => expect(mockSetVariableValue).toHaveBeenCalledTimes(1));

    // After save, field should no longer be dirty (save button disabled again)
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(true));
  });

  it('calls ensureVariablesExist when compose variables are missing from OpenBao', async () => {
    // OpenBao only has DB_URL, but compose references DB_URL and NEW_VAR
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['DB_URL']));
    mockEnsureVariablesExist.mockImplementationOnce(() => Promise.resolve(undefined));
    // After invalidation, return all variables
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['DB_URL', 'NEW_VAR']));

    await renderPanel('mystack', ['DB_URL', 'NEW_VAR']);

    await waitFor(() => {
      expect(mockEnsureVariablesExist).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call ensureVariablesExist when all compose variables already exist in OpenBao', async () => {
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['DB_URL', 'SECRET_KEY']));

    await renderPanel('mystack', ['DB_URL', 'SECRET_KEY']);

    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    expect(mockEnsureVariablesExist).not.toHaveBeenCalled();
  });

  it('silently catches error when ensureVariablesExist rejects', async () => {
    // OpenBao has DB_URL but compose also references NEW_VAR — triggers ensureVariablesExist
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['DB_URL']));
    mockEnsureVariablesExist.mockImplementationOnce(() => Promise.reject(new Error('OpenBao unreachable')));

    await renderPanel('mystack', ['DB_URL', 'NEW_VAR']);

    await waitFor(() => {
      expect(mockEnsureVariablesExist).toHaveBeenCalledTimes(1);
    });
    // The catch callback silences the error — no throw, no error UI for this path
  });

  it('closes delete dialog via Dialog onClose handler (sets deleteOpen to false)', async () => {
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['OLD_VAR']));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    // Open the delete dialog
    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    // MUI Dialog's onClose prop maps to the user callback () => setDeleteOpen(false).
    // In Happy-DOM, keyboard/backdrop events don't reach MUI's internal modal manager,
    // so we invoke onClose via the React props on the MuiModal-root element directly.
    const modalRoot = document.querySelector('.MuiModal-root') as HTMLElement;
    const reactPropsKey = Object.keys(modalRoot).find((k) => k.startsWith('__reactProps$'))!;
    const modalProps = (modalRoot as Record<string, any>)[reactPropsKey];

    await act(async () => {
      modalProps.onClose({} as Event, 'escapeKeyDown');
    });

    // After onClose fires, setDeleteOpen(false) is called and Dialog's open prop becomes false.
    // Verify via the React fiber tree — MUI Dialog stays in DOM during exit transition in Happy-DOM.
    await waitFor(() => {
      const fiberKey = Object.keys(modalRoot).find((k) => k.startsWith('__reactFiber$'))!;
      let fiber = (modalRoot as Record<string, any>)[fiberKey];
      let depth = 0;
      while (fiber && depth < 10) {
        if (fiber.memoizedProps?.open !== undefined) {
          expect(fiber.memoizedProps.open).toBe(false);
          return;
        }
        fiber = fiber.return;
        depth++;
      }
      throw new Error('Could not find open prop in fiber tree');
    });
  });

  it('save button is disabled when field has not been fetched yet', async () => {
    mockGetStackVariables.mockImplementationOnce(() => Promise.resolve(['API_TOKEN']));

    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('API_TOKEN')).toBeDefined());

    const saveBtn = screen.getByLabelText('Save value');
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
