import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackDetail } from '@/types/stacks';

// Integration test: exercises the REAL ComposeEditor (Controller + shared form)
// against the deploy guard in StackEditorForm. Only Monaco and the router hooks
// are stubbed; ComposeEditor/StackActionBar/etc. are the real components.

let mockEditorOnChange: ((v: string | undefined) => void) | undefined;
mock.module('@/lib/monaco-setup', () => ({}));
mock.module('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string | undefined) => void }) => {
    mockEditorOnChange = onChange;
    return <textarea data-testid="mock-editor" value={value} readOnly />;
  },
}));

const realRouter = await import('@tanstack/react-router');
mock.module('@tanstack/react-router', () => ({
  ...realRouter,
  useNavigate: () => mock(() => {}),
  useBlocker: () => ({ status: 'idle', proceed: () => {}, reset: () => {} }),
}));

const mockTriggerDeploy = mock((_args: unknown) => Promise.resolve({ deployId: 1 }));
const realFns = await import('@/data/stacks/functions');
mock.module('@/data/stacks/functions', () => ({
  ...realFns,
  getStackVariableValues: mock(() => Promise.resolve({})),
  getDeployHistory: mock(() => Promise.resolve([])),
  listManagedHostNames: mock(() => Promise.resolve([])),
  triggerDeploy: mockTriggerDeploy,
  deleteStack: mock(() => Promise.resolve({ status: 'removed', commitSha: 'x' })),
  updateStackSettings: mock(() => Promise.resolve({ commitSha: 'x' })),
  resumeDeploy: mock(() => Promise.resolve({ deployId: 1 })),
  rejectDeploy: mock(() => Promise.resolve({ deployId: 1 })),
}));

const detail: StackDetail = {
  name: 'web',
  host: 'host1',
  syncStatus: 'in_sync',
  deployMode: 'manual',
  icon: null,
  composeContent: 'image: nginx',
  lastDeployCommitSha: null,
  currentCommitSha: 'abc',
  variableNames: [],
};

async function renderForm() {
  const { default: StackEditorForm } = await import('@/components/stacks/StackEditorForm');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <StackEditorForm stackName="web" detail={detail} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('mock-editor')).toBeDefined());
}

describe('StackEditorForm deploy guard (real ComposeEditor)', () => {
  beforeEach(() => {
    mockTriggerDeploy.mockClear();
    mockTriggerDeploy.mockImplementation(() => Promise.resolve({ deployId: 1 }));
  });

  it('deploys immediately when the compose draft is unchanged', async () => {
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deploy' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
  });

  it('warns before deploying after the compose YAML is edited', async () => {
    await renderForm();
    act(() => { mockEditorOnChange?.('image: redis'); });
    // The compose edit marks the shared form dirty (tab dot / Save enabled).
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(screen.getByRole('heading', { name: 'Deploy with unsaved changes?' })).toBeDefined();
    expect(mockTriggerDeploy).not.toHaveBeenCalled();
  });
});
