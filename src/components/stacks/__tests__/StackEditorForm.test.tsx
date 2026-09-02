import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFormContext } from 'react-hook-form';
import type { StackDetail, StackDeployRecord, DeployStatus } from '@/types/stacks';

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

let mockCanWrite = true;
mock.module('@/hooks/useAuth', () => ({
  useCanWrite: () => mockCanWrite,
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
    onRollbackComplete: (result: { deployId: number; status: string; logs: string }) => void;
    onRollbackError: (err: Error) => void;
  }) => (
    <div>
      deploy-history
      <button onClick={() => onApprove(7)}>approve</button>
      <button onClick={() => onReject(7)}>reject</button>
      <button onClick={() => onRollbackComplete({ deployId: 99, status: 'succeeded', logs: '' })}>rollback-ok</button>
      <button onClick={() => onRollbackError(new Error('rollback boom'))}>rollback-err</button>
    </div>
  ),
}));
mock.module('@/components/stacks/StackContainersPanel', () => ({
  default: ({ onRecreate, isDeploying }: { onRecreate: () => void; isDeploying: boolean }) => (
    <div>
      containers-panel
      <button onClick={onRecreate}>containers-recreate</button>
      <span data-testid="containers-is-deploying">{String(isDeploying)}</span>
    </div>
  ),
}));
mock.module('@/components/stacks/StackActionBar', () => ({
  default: ({ onDeploy, onUpdate, onTeardown, onDelete, isDeploying, activeDeploy }: { onDeploy: () => void; onUpdate: () => void; onTeardown: () => void; onDelete: () => void; isDeploying: boolean; activeDeploy: { status: string; action: string } | null }) => (
    <div>
      <button onClick={onDeploy}>action-deploy</button>
      <button onClick={onUpdate}>action-update</button>
      <button onClick={onTeardown}>action-teardown</button>
      <button onClick={onDelete}>action-delete</button>
      <span data-testid="is-deploying">{String(isDeploying)}</span>
      <span data-testid="active-deploy">{activeDeploy ? `${activeDeploy.status}:${activeDeploy.action}` : 'none'}</span>
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
// Fresh id per call: the deployToastGate singleton dedupes by id across this whole file.
let nextDeployId = 1;
const mockTriggerDeploy = mock((_args: unknown): Promise<{ deployId: number; status: DeployStatus; logs: string }> => Promise.resolve({ deployId: nextDeployId++, status: 'succeeded', logs: '' }));
const mockDeleteStack = mock((_args: unknown): Promise<DeleteResult> => Promise.resolve({ status: 'removed', commitSha: 'x' }));
const mockUpdateSettings = mock((_args: unknown) => Promise.resolve({ commitSha: 'x' }));
const mockResumeDeploy = mock((_args: unknown): Promise<{ deployId: number; status: DeployStatus; logs: string }> => Promise.resolve({ deployId: 1, status: 'succeeded', logs: '' }));
const mockRejectDeploy = mock((_args: unknown) => Promise.resolve({ deployId: 1 }));
const mockScanDrift = mock(() => Promise.resolve({
  items: [],
  summary: { total: 0, ghost: 0, untracked: 0, content: 0 },
  scanErrors: [],
}));
const mockGetDeployHistory = mock((_args: unknown): Promise<StackDeployRecord[]> => Promise.resolve([]));
const realFns = await import('@/data/stacks/functions');
mock.module('@/data/stacks/functions', () => ({
  ...realFns,
  getDeployHistory: mockGetDeployHistory,
  listManagedHostNames: mock(() => Promise.resolve([])),
  triggerDeploy: mockTriggerDeploy,
  deleteStack: mockDeleteStack,
  updateStackSettings: mockUpdateSettings,
  resumeDeploy: mockResumeDeploy,
  rejectDeploy: mockRejectDeploy,
  scanDrift: mockScanDrift,
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
  const ui = (d: StackDetail) => (
    <QueryClientProvider client={queryClient}>
      <StackEditorForm stackName="web" detail={d} />
    </QueryClientProvider>
  );
  const result = render(ui(detail));
  return { ...result, rerenderWith: (d: StackDetail) => result.rerender(ui(d)) };
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
    mockTriggerDeploy.mockImplementation(() => Promise.resolve({ deployId: nextDeployId++, status: 'succeeded' as const, logs: '' }));
    mockDeleteStack.mockImplementation(() => Promise.resolve({ status: 'removed', commitSha: 'x' }));
    mockUpdateSettings.mockImplementation(() => Promise.resolve({ commitSha: 'x' }));
    mockResumeDeploy.mockImplementation(() => Promise.resolve({ deployId: 1, status: 'succeeded' as const, logs: '' }));
    mockRejectDeploy.mockImplementation(() => Promise.resolve({ deployId: 1 }));
    capturedBlockerOpts = undefined;
    blockerReturn = { status: 'idle', proceed: proceedSpy, reset: resetSpy };
    mockCanWrite = true;
    mockScanDrift.mockClear();
    mockGetDeployHistory.mockClear();
    mockGetDeployHistory.mockImplementation(() => Promise.resolve([]));
  });

  function deployRecord(overrides: Partial<StackDeployRecord>): StackDeployRecord {
    return {
      id: 7,
      stack: 'web',
      host: 'host1',
      commitSha: 'abc',
      envHash: '',
      status: 'succeeded',
      trigger: 'ui',
      action: 'deploy',
      forceRecreate: false,
      logs: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('blocks the actions while the history holds an active row for this host', async () => {
    mockGetDeployHistory.mockImplementation(() => Promise.resolve([
      deployRecord({ id: 9, status: 'in_progress', action: 'update' }),
      deployRecord({ id: 8, status: 'succeeded' }),
    ]));
    await renderForm();
    await waitFor(() => expect(screen.getByTestId('active-deploy').textContent).toBe('in_progress:update'));
    expect(screen.getByTestId('is-deploying').textContent).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'action-update' }));
    expect(mockTriggerDeploy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    await waitFor(() => expect(screen.getByTestId('containers-is-deploying').textContent).toBe('true'));
  });

  it('ignores active rows that belong to another host', async () => {
    mockGetDeployHistory.mockImplementation(() => Promise.resolve([
      deployRecord({ id: 9, status: 'in_progress', host: 'host2' }),
    ]));
    await renderForm();
    await waitFor(() => expect(mockGetDeployHistory).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('active-deploy').textContent).toBe('none'));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-update' })); });
    expect(mockTriggerDeploy).toHaveBeenCalledTimes(1);
  });

  it('does not scan for drift without deploy permission', async () => {
    mockCanWrite = false;
    await renderForm();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'web' })).toBeDefined());
    expect(mockScanDrift).not.toHaveBeenCalled();
  });

  it('rescans for drift after a successful deploy', async () => {
    await renderForm();
    await waitFor(() => expect(mockScanDrift).toHaveBeenCalledTimes(1));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });

    await waitFor(() => expect(mockScanDrift).toHaveBeenCalledTimes(2));
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

  it('adopts newly saved compose content when the field is clean', async () => {
    const { rerenderWith } = await renderForm();
    const input = screen.getByLabelText('compose-input') as HTMLInputElement;
    expect(input.value).toBe('image: nginx');

    rerenderWith({ ...detail, composeContent: 'image: redis' });
    await waitFor(() => expect(input.value).toBe('image: redis'));
  });

  it('preserves an in-progress compose draft when saved content changes underneath', async () => {
    const { rerenderWith } = await renderForm();
    const input = screen.getByLabelText('compose-input') as HTMLInputElement;
    act(() => { fireEvent.change(input, { target: { value: 'image: mine' } }); });

    rerenderWith({ ...detail, composeContent: 'image: redis' });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));
    expect(input.value).toBe('image: mine');
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

  it('ignores a second Deploy click while a deploy is already in flight', async () => {
    let resolveDeploy!: (value: { deployId: number; status: 'succeeded'; logs: string }) => void;
    mockTriggerDeploy.mockImplementationOnce(() => new Promise((resolve) => { resolveDeploy = resolve; }));
    await renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'action-deploy' }));
    await waitFor(() => expect(screen.getByTestId('is-deploying').textContent).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: 'action-deploy' }));
    expect(mockTriggerDeploy).toHaveBeenCalledTimes(1);

    await act(async () => { resolveDeploy({ deployId: nextDeployId++, status: 'succeeded', logs: '' }); });
  });

  it('deploys immediately when there are no unsaved changes', async () => {
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of web succeeded', 'success');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-teardown' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(2));
    expect(mockShowToast).toHaveBeenCalledWith('Teardown of web succeeded', 'success');
  });

  it('warns before deploying with unsaved changes and deploys on confirm', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'action-deploy' }));
    // Deploy is held until the warning is confirmed.
    expect(screen.getByRole('heading', { name: 'Deploy with unsaved changes?' })).toBeDefined();
    expect(mockTriggerDeploy).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deploy anyway' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
  });

  it('does not deploy when the unsaved-changes warning is cancelled', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'action-deploy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockTriggerDeploy).not.toHaveBeenCalled();
  });

  it('updates immediately when there are no unsaved changes', async () => {
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-update' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
    expect(mockTriggerDeploy).toHaveBeenCalledWith({
      data: { stack: 'web', host: 'host1', action: 'update', forceRecreate: undefined },
    });
    expect(mockShowToast).toHaveBeenCalledWith('Image update of web succeeded', 'success');
  });

  it('warns before updating with unsaved changes and updates on confirm', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'action-update' }));
    expect(screen.getByRole('heading', { name: 'Update images with unsaved changes?' })).toBeDefined();
    expect(mockTriggerDeploy).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update anyway' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
  });

  it('does not update when the unsaved-changes warning is cancelled', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'action-update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockTriggerDeploy).not.toHaveBeenCalled();
  });

  it('recreates through the deploy mutation with forceRecreate true when there are no unsaved changes', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Containers/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'containers-recreate' })); });

    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
    expect(mockTriggerDeploy).toHaveBeenCalledWith({
      data: { stack: 'web', host: 'host1', action: 'deploy', forceRecreate: true },
    });
  });

  it('warns before recreating with unsaved changes using recreate-specific copy, and recreates on confirm', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('tab', { name: /Containers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'containers-recreate' }));
    expect(screen.getByRole('heading', { name: 'Recreate with unsaved changes?' })).toBeDefined();
    expect(screen.getByText(/this recreates all containers from the last saved compose/i)).toBeDefined();
    expect(mockTriggerDeploy).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Recreate anyway' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
    expect(mockTriggerDeploy).toHaveBeenCalledWith({
      data: { stack: 'web', host: 'host1', action: 'deploy', forceRecreate: true },
    });
  });

  it('does not recreate when the unsaved-changes warning is cancelled', async () => {
    await renderForm();
    act(() => { fireEvent.change(screen.getByLabelText('compose-input'), { target: { value: 'image: redis' } }); });
    await waitFor(() => expect(capturedBlockerOpts?.shouldBlockFn()).toBe(true));

    fireEvent.click(screen.getByRole('tab', { name: /Containers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'containers-recreate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockTriggerDeploy).not.toHaveBeenCalled();
  });

  it('surfaces a toast when an update fails', async () => {
    mockTriggerDeploy.mockImplementation(() => Promise.reject(new Error('update failed')));
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-update' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('update failed', 'error'));
  });

  it('surfaces a toast when a deploy fails (request rejects)', async () => {
    mockTriggerDeploy.mockImplementation(() => Promise.reject(new Error('deploy failed')));
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('deploy failed', 'error'));
  });

  it('formats a failed outcome when the deploy request resolves with status failed', async () => {
    mockTriggerDeploy.mockImplementation(() => Promise.resolve({ deployId: nextDeployId++, status: 'failed' as const, logs: 'image not found' }));
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Deploy of web failed: image not found', 'error'));
  });

  it('approves and rejects pending deploys from the deploys panel', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'approve' })); });
    await waitFor(() => expect(mockResumeDeploy).toHaveBeenCalledWith({ data: { deployId: 7 } }));
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of web succeeded', 'success');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'reject' })); });
    await waitFor(() => expect(mockRejectDeploy).toHaveBeenCalledWith({ data: { deployId: 7 } }));
  });

  it('formats a failed outcome when the approve request resolves with status failed', async () => {
    mockResumeDeploy.mockImplementation(() => Promise.resolve({ deployId: 1, status: 'failed' as const, logs: 'agent down' }));
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'approve' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Deploy of web failed: agent down', 'error'));
  });

  it('cross-source dedupe through the real gate: a pre-claim suppresses the mutation toast, and the mutation claiming first suppresses a later check for the same id', async () => {
    const { deployToastGate } = await import('@/lib/stacks/deploy-outcome-toast');
    await renderForm();

    const preClaimedId = nextDeployId;
    deployToastGate.claim(preClaimedId);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockTriggerDeploy).toHaveBeenCalledTimes(1));
    expect(mockShowToast).not.toHaveBeenCalledWith('Deploy of web succeeded', 'success');

    mockShowToast.mockClear();
    const secondId = nextDeployId;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'action-deploy' })); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Deploy of web succeeded', 'success'));
    expect(deployToastGate.shouldToast(secondId)).toBe(false);
  });

  it('reports rollback outcomes via toast', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('tab', { name: /Deploys/ }));

    fireEvent.click(screen.getByRole('button', { name: 'rollback-ok' }));
    expect(mockShowToast).toHaveBeenCalledWith('Rollback of web succeeded', 'success');

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

  it('fires no optimistic toast for a teardown-pending delete: the SSE outcome owns it', async () => {
    mockDeleteStack.mockImplementation(() => Promise.resolve({ status: 'teardown-pending', deployId: 5 }));
    await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'action-delete' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'confirm-delete' })); });
    await waitFor(() => expect(mockDeleteStack).toHaveBeenCalledTimes(1));
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});
