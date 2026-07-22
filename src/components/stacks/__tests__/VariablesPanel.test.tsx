import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import type { StackFormValues } from '@/components/stacks/stack-form';

const mockGetValues = mock((): Promise<Record<string, string>> =>
  Promise.resolve({ DB_URL: 'super-secret', SECRET_KEY: 'super-secret' }));
const mockSetSecret = mock(() => Promise.resolve(undefined));
const mockDeleteSecret = mock(() => Promise.resolve(undefined));
const mockEnsureVariablesExist = mock(() => Promise.resolve(undefined));

const realModule = await import('@/data/stacks/functions');

mock.module('@/data/stacks/functions', () => ({
  ...realModule,
  getStackVariableValues: mockGetValues,
  setVariableValue: mockSetSecret,
  deleteVariable: mockDeleteSecret,
  ensureVariablesExist: mockEnsureVariablesExist,
}));

const mockShowToast = mock((_message: string, _severity: string) => {});
mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

function FormHarness({ children }: { children: React.ReactNode }) {
  const form = useForm<StackFormValues>({ defaultValues: { compose: '', secrets: {} } });
  return <FormProvider {...form}>{children}</FormProvider>;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <FormHarness>{children}</FormHarness>
      </QueryClientProvider>
    );
  };
}

async function renderPanel(stackName = 'mystack', composeVariables: string[] = []) {
  const { default: VariablesPanel } = await import('../VariablesPanel');
  return render(
    <VariablesPanel stackName={stackName} composeVariables={composeVariables} />,
    { wrapper: createWrapper() },
  );
}

describe('VariablesPanel', () => {
  beforeEach(() => {
    mockGetValues.mockClear();
    mockSetSecret.mockClear();
    mockDeleteSecret.mockClear();
    mockEnsureVariablesExist.mockClear();
    mockShowToast.mockClear();
    mockGetValues.mockImplementation(() => Promise.resolve({ DB_URL: 'super-secret', SECRET_KEY: 'super-secret' }));
    mockSetSecret.mockImplementation(() => Promise.resolve(undefined));
    mockDeleteSecret.mockImplementation(() => Promise.resolve(undefined));
    mockEnsureVariablesExist.mockImplementation(() => Promise.resolve(undefined));
  });

  it('renders loading skeleton while fetching', async () => {
    let resolveVariables!: (v: Record<string, string>) => void;
    mockGetValues.mockImplementationOnce(
      () => new Promise<Record<string, string>>((res) => { resolveVariables = res; }),
    );
    const { container } = await renderPanel();
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
    resolveVariables({});
    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    });
  });

  it('shows error alert when secrets store is unreachable', async () => {
    mockGetValues.mockImplementationOnce(() => Promise.reject(new Error('Connection refused')));
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Unable to load secrets/)).toBeDefined();
    });
  });

  it('renders variable rows from secrets data', async () => {
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText('DB_URL')).toBeDefined();
      expect(screen.getByText('SECRET_KEY')).toBeDefined();
    });
  });

  it('loads every value in a single bulk request', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());
    expect(mockGetValues).toHaveBeenCalledTimes(1);
    expect(mockGetValues).toHaveBeenCalledWith({ data: { stackName: 'mystack' } });
  });

  it('renders empty state when no variables exist', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({}));
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText('No variables yet.')).toBeDefined();
    });
  });

  it('seeds field values from the secrets store', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ API_TOKEN: 'tok_123' }));
    await renderPanel();
    await waitFor(() => {
      expect((screen.getByLabelText('API_TOKEN value') as HTMLInputElement).value).toBe('tok_123');
    });
  });

  it('masks values by default and the single reveal toggle unmasks all rows', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    const dbInput = screen.getByLabelText('DB_URL value') as HTMLInputElement;
    const keyInput = screen.getByLabelText('SECRET_KEY value') as HTMLInputElement;
    expect(dbInput.type).toBe('password');
    expect(keyInput.type).toBe('password');

    fireEvent.click(screen.getByLabelText('Reveal all values'));
    expect(dbInput.type).toBe('text');
    expect(keyInput.type).toBe('text');

    fireEvent.click(screen.getByLabelText('Hide all values'));
    expect(dbInput.type).toBe('password');
  });

  it('fields are editable without revealing and Save changes persists edits', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ API_KEY: 'original-value' }));
    await renderPanel();
    await waitFor(() => {
      expect((screen.getByLabelText('API_KEY value') as HTMLInputElement).value).toBe('original-value');
    });

    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByLabelText('API_KEY value');
    fireEvent.change(input, { target: { value: 'new-value' } });

    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveBtn);

    await waitFor(() => expect(mockSetSecret).toHaveBeenCalledTimes(1));
    expect(mockSetSecret).toHaveBeenCalledWith({
      data: { stackName: 'mystack', variableName: 'API_KEY', value: 'new-value' },
    });
    // After save the field rebaselines to clean, disabling the button again.
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(true));
  });

  it('only writes the edited rows on Save changes', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ A: 'v', B: 'v' }));
    await renderPanel();
    await waitFor(() => expect((screen.getByLabelText('A value') as HTMLInputElement).value).toBe('v'));

    fireEvent.change(screen.getByLabelText('B value'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockSetSecret).toHaveBeenCalledTimes(1));
    expect(mockSetSecret).toHaveBeenCalledWith({
      data: { stackName: 'mystack', variableName: 'B', value: 'changed' },
    });
  });

  it('shows a toast error when Save changes fails', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ API_KEY: 'original' }));
    mockSetSecret.mockImplementationOnce(() => Promise.reject(new Error('write failed')));
    await renderPanel();
    await waitFor(() => expect((screen.getByLabelText('API_KEY value') as HTMLInputElement).value).toBe('original'));

    fireEvent.change(screen.getByLabelText('API_KEY value'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockSetSecret).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('write failed', 'error'));
  });

  it('shows a success toast when secrets save', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ API_KEY: 'original' }));
    await renderPanel();
    await waitFor(() => expect((screen.getByLabelText('API_KEY value') as HTMLInputElement).value).toBe('original'));

    fireEvent.change(screen.getByLabelText('API_KEY value'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Secrets saved', 'success'));
  });

  it('delete button is disabled with tooltip when variable is referenced in compose', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ DB_URL: '' }));
    await renderPanel('mystack', ['DB_URL']);
    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('delete button is enabled when variable is not referenced in compose', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ ORPHAN_VAR: '' }));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('ORPHAN_VAR')).toBeDefined());

    const deleteBtn = screen.getByLabelText('Delete variable');
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens delete confirmation dialog when delete is clicked', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ OLD_VAR: '' }));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Delete variable' })).toBeDefined();
      expect(screen.getByText(/This cannot be undone/)).toBeDefined();
    });
  });

  it('calls deleteVariable and refreshes after confirming delete', async () => {
    mockGetValues
      .mockImplementationOnce(() => Promise.resolve({ TEMP_VAR: '' }))
      .mockImplementationOnce(() => Promise.resolve({}));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('TEMP_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteSecret).toHaveBeenCalledTimes(1);
      // onDeleted invalidates the values query, triggering a re-fetch.
      expect(mockGetValues).toHaveBeenCalledTimes(2);
    });
  });

  it('does not call deleteVariable when Cancel is clicked in the dialog', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ OLD_VAR: '' }));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  it('shows error inside delete dialog when delete mutation fails', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ OLD_VAR: '' }));
    mockDeleteSecret.mockImplementationOnce(() => Promise.reject(new Error('delete failed')));
    await renderPanel('mystack', []);
    await waitFor(() => expect(screen.getByText('OLD_VAR')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Delete variable'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('Failed to delete variable.')).toBeDefined());
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('calls ensureVariablesExist when compose variables are missing from the secrets store', async () => {
    mockGetValues
      .mockImplementationOnce(() => Promise.resolve({ DB_URL: '' }))
      .mockImplementationOnce(() => Promise.resolve({ DB_URL: '', NEW_VAR: '' }));
    await renderPanel('mystack', ['DB_URL', 'NEW_VAR']);

    await waitFor(() => {
      expect(mockEnsureVariablesExist).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call ensureVariablesExist when all compose variables already exist', async () => {
    mockGetValues.mockImplementation(() => Promise.resolve({ DB_URL: '', SECRET_KEY: '' }));
    await renderPanel('mystack', ['DB_URL', 'SECRET_KEY']);
    await waitFor(() => expect(screen.getByText('DB_URL')).toBeDefined());

    expect(mockEnsureVariablesExist).not.toHaveBeenCalled();
  });

  it('silently catches error when ensureVariablesExist rejects', async () => {
    mockGetValues.mockImplementationOnce(() => Promise.resolve({ DB_URL: '' }));
    mockEnsureVariablesExist.mockImplementationOnce(() => Promise.reject(new Error('secrets store unreachable')));
    await renderPanel('mystack', ['DB_URL', 'NEW_VAR']);

    await waitFor(() => {
      expect(mockEnsureVariablesExist).toHaveBeenCalledTimes(1);
    });
  });
});
