import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFormContext } from 'react-hook-form';
import type { StackDetail } from '@/types/stacks';

// Router hooks are the only things StackEditorForm needs from the router; stub
// them so we can drive the blocker state and observe navigation.
const realRouter = await import('@tanstack/react-router');
const navigateSpy = mock((_opts: unknown) => {});
let capturedBlockerOpts: { shouldBlockFn: () => boolean; enableBeforeUnload?: () => boolean } | undefined;
const proceedSpy = mock(() => {});
const resetSpy = mock(() => {});
let blockerReturn: { status: 'idle' | 'blocked'; proceed: () => void; reset: () => void } = {
  status: 'idle', proceed: proceedSpy, reset: resetSpy,
};
mock.module('@tanstack/react-router', () => ({
  ...realRouter,
  useNavigate: () => navigateSpy,
  useBlocker: (opts: typeof capturedBlockerOpts) => { capturedBlockerOpts = opts; return blockerReturn; },
}));

// Compose/secrets panels are stubbed with inputs bound to the shared form so
// tests can dirty the fields; the rest are inert stand-ins.
mock.module('@/components/stacks/ComposeEditorLoader', () => ({
  default: () => {
    const { register } = useFormContext();
    return <input aria-label="compose-input" {...register('compose')} />;
  },
}));
mock.module('@/components/stacks/VariablesPanel', () => ({
  default: () => {
    const { register } = useFormContext();
    return <input aria-label="secret-input" {...register('secrets.FOO')} />;
  },
}));
mock.module('@/components/stacks/DeployHistoryList', () => ({
  default: ({ onApprove, onReject, onRollbackComplete, onRollbackError }: {
    onApprove: (id: number) => void;
    onReject: (id: number) => void;
    onRollbackComplete: () => void;
    onRollbackError: (err: Error) => void;
  }) => (
    <div>
      deploy-history
      <button onClick={() => onApprove(7)}>approve</button>
      <button onClick={() => onReject(7)}>reject</button>
      <button onClick={onRollbackComplete}>rollback-ok</button>
      <button onClick={() => onRollbackError(new Error('rollback boom'))}>rollback-err</button>
    </div>
  ),
}));
mock.module('@/components/stacks/StackContainersPanel', () => ({ default: () => <div>containers-panel</div> }));
mock.module('@/components/stacks/StackActionBar', () => ({
  default: ({ onDeploy, onTeardown, onDelete }: { onDeploy: () => void; onTeardown: () => void; onDelete: () => void }) => (
    <div>
      <button onClick={onDeploy}>action-deploy</button>
      <button onClick={onTeardown}>action-teardown</button>
      <button onClick={onDelete}>action-delete</button>
    </div>
  ),
}));
mock.module('@/components/stacks/StackSettingsDialog', () => ({
  default: ({ open, onSave }: { open: boolean; onSave: (host: string, autoDeploy: boolean) => void }) =>
    open ? <button onClick={() => onSave('host2', true)}>settings-save</button> : null,
}));
mock.module('@/components/stacks/DeleteStackDialog', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: (teardown: boolean) => void }) =>
    open ? <button onClick={() => onConfirm(false)}>confirm-delete</button> : null,
}));

const mockShowToast = mock((_message: string, _severity: string) => {});
mock.module('@/hooks/toastAtom', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

type DeleteResult = { status: 'removed'; commitSha: string } | { status: 'teardown-pending'; deployId: number };
const mockTriggerDeploy = mock((_args: unknown) => Promise.resolve({ deployId: 1 }));
const mockDeleteStack = mock((_args: unknown): Promise<DeleteResult> => Promise.resolve({ status: 'removed', commitSha: 'x' }));
const mockUpdateSettings = mock((_args: unknown) => Promise.resolve({ commitSha: 'x' }));
const mockResumeDeploy = mock((_args: unknown) => Promise.resolve({ deployId: 1 }));
const mockRejectDeploy = mock((_args: unknown) => Promise.resolve({ deployId: 1 }));
const realFns = await import('@/data/stacks/functions');
mock.module('@/data/stacks/functions', () => ({
  ...realFns,
  getDeployHistory: mock(() => Promise.resolve([])),
  listManagedHostNames: mock(() => Promise.resolve([])),
  triggerDeploy: mockTriggerDeploy,
  deleteStack: mockDeleteStack,
  updateStackSettings: mockUpdateSettings,
  resumeDeploy: mockResumeDeploy,
  rejectDeploy: mockRejectDeploy,
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
  const { default: StackEditorForm } = await import('../StackEditorForm');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StackEditorForm stackName="web" detail={detail} />
    </QueryClientProvider>,
  );
}

describe('StackEditorForm', () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    proceedSpy.mockClear();
    resetSpy.mockClear();
    mockShowToast.mockClear();
    mockTriggerDeploy.mockClear();
    mockDeleteStack.mockClear();
    mockUpdateSettings.mockClear();
    mockResumeDeploy.mockClear();
    mockRejectDeploy.mockClear();
    mockTriggerDeploy.mockImplementation(() => Promise.resolve({ deployId: 1 }));
    mockDeleteStack.mockImplementation(() => Promise.resolve({ status: 'removed', commitSha: 'x' }));
    mockUpdateSettings.mockImplementation(() => Promise.resolve({ commitSha: 'x' }));
    mockResumeDeploy.mockImplementation(() => Promise.resolve({ deployId: 1 }));
    mockRejectDeploy.mockImplementation(() => Promise.resolve({ deployId: 1 }));
    capturedBlockerOpts = undefined;
    blockerReturn = { status: 'idle', proceed: proceedSpy, reset: resetSpy };
  });

  it('renders the header and all four tabs', async () => {
    await renderForm();
    expect(screen.getByRole('heading', { name: 'web' })).toBeDefined();
    for (const name of ['Compose', 'Secrets', 'Containers', 'Deploys']) {
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeDefined();
    }
  });

  it('is not dirty initially: no tab dot and blocker allows navigation', async () => {
    await renderForm();
    expect(screen.queryByLabelText('unsaved changes')).toBeNull();
    expect(capturedBlockerOpts?.shouldBlockFn()).toBe(false);
  });

  it('marks the Compose tab dirty and blocks navigation once the draft changes', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });

    await waitFor(() => expect(screen.getAllByLabelText('unsaved changes')).toHaveLength(1));
    expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true);
    expect(capturedBlockerOpts?.enableBeforeUnload?.()).toBe(true);
  });

  it('tracks dirty state for edited secret values', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Secrets/ }));
    act(() => { fireEvent.change(screen.getByLabelText('secret-input'), { target: { value: 'sekret' } }); });

    await waitFor(() => expect(screen.getAllByLabelText('unsaved changes')).toHaveLength(1));
    expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true);
  });

  it('switches to the containers and deploys panels', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Containers/ }));
    expect(screen.getByText('containers-panel')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));
    expect(screen.getByText('deploy-history')).toBeDefined();
  });

  it('shows the unsaved-changes dialog while blocked and wires the actions', async () => {
    blockerReturn = { status: 'blocked', proceed: proceedSpy, reset: resetSpy };
    await renderForm();

    expect(screen.getByRole('heading', { name: 'Unsaved changes' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(proceedSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('deleting the stack navigates away and bypasses the guard', async () => {
    await renderForm();
    // Dirty the draft so the guard would otherwise block.
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'action-delete' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'confirm-delete' })); });

    expect(navigateSpy).toHaveBeenCalledWith({ to: '/stacks' });
    // Bypass flag is set, so the blocker no longer blocks the delete navigation.
    expect(capturedBlockerOpts?.shouldBlockFn()).toBe(false);
  });

  it('triggers deploy and teardown from the action bar', async () => {
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
    expect(mockShowToast).toHaveBeenCalledWith('deploy triggered successfully', 'success');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-teardown' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(2));
    expect(mockShowToast).toHaveBeenCalledWith('teardown triggered successfully', 'success');
  });

  it('surfaces a toast when a deploy fails', async () => {
    mockTriggerDeploy.mockImplementation(() => Promise.reject(new Error('deploy failed')));
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('deploy failed', 'error'));
  });

  it('approves and rejects pending deploys from the deploys panel', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'approve' })); });
    await waitFor(() => expect(mockResumeDeploy).toHaveBeenCalledWith({ data: { deployId: 7 } }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'reject' })); });
    await waitFor(() => expect(mockRejectDeploy).toHaveBeenCalledWith({ data: { deployId: 7 } }));
  });

  it('reports rollback outcomes via toast', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));

    fireEvent.click(screen.getByRole('button', { name: 'rollback-ok' }));
    expect(mockShowToast).toHaveBeenCalledWith('Rollback triggered successfully', 'success');

    fireEvent.click(screen.getByRole('button', { name: 'rollback-err' }));
    expect(mockShowToast).toHaveBeenCalledWith('rollback boom', 'error');
  });

  it('saves stack settings from the settings dialog', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'stack settings' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings-save' })); });

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith({
      data: { stackName: 'web', host: 'host2', autoDeploy: true },
    }));
    expect(mockShowToast).toHaveBeenCalledWith('Stack settings updated', 'success');
  });

  it('surfaces toasts on approve, reject, and settings failures', async () => {
    mockResumeDeploy.mockImplementation(() => Promise.reject(new Error('approve failed')));
    mockRejectDeploy.mockImplementation(() => Promise.reject(new Error('reject failed')));
    mockUpdateSettings.mockImplementation(() => Promise.reject(new Error('settings failed')));
    await renderForm();

    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'approve' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('approve failed', 'error'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'reject' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('reject failed', 'error'));

    fireEvent.click(screen.getByRole('button', { name: 'stack settings' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings-save' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('settings failed', 'error'));
  });

  it('surfaces a toast when deletion fails', async () => {
    mockDeleteStack.mockImplementation(() => Promise.reject(new Error('delete failed')));
    await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'action-delete' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'confirm-delete' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('delete failed', 'error'));
  });

  it('shows a teardown-pending toast when a teardown is queued', async () => {
    mockDeleteStack.mockImplementation(() => Promise.resolve({ status: 'teardown-pending', deployId: 5 }));
    await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'action-delete' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'confirm-delete' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('Teardown queued'), 'success',
    ));
  });
});
