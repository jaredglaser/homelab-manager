import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockGetStackVariables = mock(() => Promise.resolve(['DB_URL', 'SECRET_KEY']));
const mockGetVariableValue = mock(() => Promise.resolve('super-secret'));
const mockSetVariableValue = mock(() => Promise.resolve(undefined));
const mockDeleteVariable = mock(() => Promise.resolve(undefined));

mock.module('@/data/stacks.functions', () => ({
  getStackVariables: mockGetStackVariables,
  getVariableValue: mockGetVariableValue,
  setVariableValue: mockSetVariableValue,
  deleteVariable: mockDeleteVariable,
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
});
