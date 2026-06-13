import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackDeployRecord } from '@/types/stacks';
import type { triggerDeploy } from '@/data/stacks/functions';
import DeployHistoryList from '../DeployHistoryList';

/**
 * Test-only stub for triggerDeploy. Injected via the `_triggerDeploy` prop
 * because bun's mock() doesn't structurally match the createServerFn fetcher
 * type (extra properties like url/method/__executeServer); the cast happens
 * at the seam.
 */
const mockTriggerDeploy = mock(() => Promise.resolve({ deployId: 1 }));
const triggerDeployStub = mockTriggerDeploy as unknown as typeof triggerDeploy;

const mockRecords: StackDeployRecord[] = [
  {
    id: 1,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'a1b2c3d4e5f6',
    envHash: 'abc123',
    status: 'succeeded',
    trigger: 'ui',
    action: 'deploy',
    forceRecreate: false,
    logs: 'Deploy output here',
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'f6e5d4c3b2a1',
    envHash: 'def456',
    status: 'failed',
    trigger: 'git_push',
    action: 'deploy',
    forceRecreate: false,
    logs: 'Error: something went wrong',
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
  },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('DeployHistoryList', () => {
  it('renders loading skeletons when isLoading is true', () => {
    const { container } = render(
      <DeployHistoryList records={[]} isLoading={true} />,
      { wrapper: createWrapper() },
    );
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBe(3);
  });

  it('renders empty message when no records', () => {
    render(<DeployHistoryList records={[]} isLoading={false} />, { wrapper: createWrapper() });
    expect(screen.getByText('No deploy history.')).toBeDefined();
  });

  it('renders deploy records with commit sha', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />, { wrapper: createWrapper() });
    expect(screen.getByText('a1b2c3d')).toBeDefined();
    expect(screen.getByText('f6e5d4c')).toBeDefined();
  });

  it('renders status badges', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />, { wrapper: createWrapper() });
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1);
  });

  it('renders action labels', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />, { wrapper: createWrapper() });
    expect(screen.getAllByText('Deploy')).toHaveLength(2);
  });

  it('expands log output on click', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('a1b2c3d'));
    expect(screen.getByText('Deploy output here')).toBeDefined();
  });

  it('shows Rollback button for succeeded records when stackName and host are provided', () => {
    render(
      <DeployHistoryList
        records={mockRecords}
        isLoading={false}
        stackName="plex"
        host="homeserver"
      />,
      { wrapper: createWrapper() },
    );
    // Only the succeeded record (id=1) gets a Rollback button; failed (id=2) does not
    const rollbackButtons = screen.getAllByText('Rollback');
    expect(rollbackButtons.length).toBe(1);
  });

  it('does not show Rollback buttons when stackName/host are not provided', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />, { wrapper: createWrapper() });
    expect(screen.queryByText('Rollback')).toBeNull();
  });

  it('opens RollbackDialog when Rollback button is clicked', () => {
    render(
      <DeployHistoryList
        records={mockRecords}
        isLoading={false}
        stackName="plex"
        host="homeserver"
      />,
      { wrapper: createWrapper() },
    );
    fireEvent.click(screen.getByText('Rollback'));
    expect(screen.getByText('Rollback plex?')).toBeDefined();
  });

  it('shows "No deploys match the selected filters." when all records are filtered out', () => {
    // Two records with no_change and pending statuses so hasStatusVariety is true (filter UI renders),
    // but neither is 'succeeded' or 'failed', so clicking "Succeeded" yields zero matches.
    const noMatchRecords: StackDeployRecord[] = [
      {
        id: 3,
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'aabbccdd1122',
        envHash: 'ghi789',
        status: 'no_change',
        trigger: 'ui',
        action: 'deploy',
        forceRecreate: false,
        logs: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 4,
        stack: 'plex',
        host: 'homeserver',
        commitSha: '11223344aabb',
        envHash: 'jkl012',
        status: 'pending',
        trigger: 'ui',
        action: 'deploy',
        forceRecreate: false,
        logs: null,
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
      },
    ];

    render(
      <DeployHistoryList records={noMatchRecords} isLoading={false} />,
      { wrapper: createWrapper() },
    );

    // Click the "Succeeded" toggle button: no records have status 'succeeded', so none match
    const succeededButton = screen.getByRole('button', { name: 'Succeeded' });
    fireEvent.click(succeededButton);
    expect(screen.getByText('No deploys match the selected filters.')).toBeDefined();
  });

  it('calls triggerDeploy when rollback is confirmed', async () => {
    mockTriggerDeploy.mockClear();

    render(
      <DeployHistoryList
        records={mockRecords}
        isLoading={false}
        stackName="plex"
        host="homeserver"
        _triggerDeploy={triggerDeployStub}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Rollback'));
    expect(screen.getByText('Rollback plex?')).toBeDefined();

    fireEvent.click(screen.getByText('Confirm Rollback'));

    await waitFor(() => {
      expect(mockTriggerDeploy).toHaveBeenCalledTimes(1);
    });

    expect(mockTriggerDeploy).toHaveBeenCalledWith({
      data: {
        stack: 'plex',
        host: 'homeserver',
        action: 'deploy',
        commitSha: 'a1b2c3d4e5f6',
      },
    });
  });

  it('expands log output on keyboard Enter key', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />, { wrapper: createWrapper() });
    const shaText = screen.getByText('a1b2c3d');
    const rowButton = shaText.closest('[role="button"]');
    fireEvent.keyDown(rowButton!, { key: 'Enter' });
    expect(screen.getByText('Deploy output here')).toBeDefined();
  });

  it('shows "Force Deploy" label when forceRecreate is true', () => {
    const forceRecord: StackDeployRecord[] = [
      {
        id: 10,
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'aabb112233',
        envHash: 'xyz',
        status: 'succeeded',
        trigger: 'ui',
        action: 'deploy',
        forceRecreate: true,
        logs: null,
        createdAt: new Date().toISOString(),
      },
    ];
    render(<DeployHistoryList records={forceRecord} isLoading={false} />, { wrapper: createWrapper() });
    expect(screen.getByText('Force Deploy')).toBeDefined();
  });

  it('calls onRollbackComplete after successful rollback', async () => {
    mockTriggerDeploy.mockClear();
    const onComplete = mock(() => {});

    render(
      <DeployHistoryList
        records={mockRecords}
        isLoading={false}
        stackName="plex"
        host="homeserver"
        onRollbackComplete={onComplete}
        _triggerDeploy={triggerDeployStub}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Rollback'));
    fireEvent.click(screen.getByText('Confirm Rollback'));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('calls onRollbackError when rollback fails', async () => {
    const failingTriggerDeploy = mock(() => Promise.reject(new Error('deploy failed'))) as unknown as typeof triggerDeploy;
    const onError = mock(() => {});

    render(
      <DeployHistoryList
        records={mockRecords}
        isLoading={false}
        stackName="plex"
        host="homeserver"
        onRollbackError={onError}
        _triggerDeploy={failingTriggerDeploy}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Rollback'));
    fireEvent.click(screen.getByText('Confirm Rollback'));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });

  describe('pending approval workflow', () => {
    const pendingRecord: StackDeployRecord = {
      id: 77,
      stack: 'plex',
      host: 'homeserver',
      commitSha: 'pending12345',
      envHash: 'envhash',
      status: 'pending',
      trigger: 'git_push',
      action: 'deploy',
      forceRecreate: false,
      logs: null,
      createdAt: new Date().toISOString(),
    };

    it('shows Approve + Reject buttons and "Pending approval" chip for pending rows when handlers are provided', () => {
      const onApprove = mock(() => {});
      const onReject = mock(() => {});
      render(
        <DeployHistoryList
          records={[pendingRecord]}
          isLoading={false}
          stackName="plex"
          host="homeserver"
          onApprove={onApprove}
          onReject={onReject}
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.getByText('Approve')).toBeDefined();
      expect(screen.getByText('Reject')).toBeDefined();
      expect(screen.getByText('Pending approval')).toBeDefined();
    });

    it('does not show Approve/Reject buttons for non-pending rows', () => {
      const onApprove = mock(() => {});
      const onReject = mock(() => {});
      render(
        <DeployHistoryList
          records={mockRecords}
          isLoading={false}
          stackName="plex"
          host="homeserver"
          onApprove={onApprove}
          onReject={onReject}
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.queryByText('Approve')).toBeNull();
      expect(screen.queryByText('Reject')).toBeNull();
    });

    it('calls onApprove with the deploy id when Approve is clicked', () => {
      const onApprove = mock(() => {});
      const onReject = mock(() => {});
      render(
        <DeployHistoryList
          records={[pendingRecord]}
          isLoading={false}
          stackName="plex"
          host="homeserver"
          onApprove={onApprove}
          onReject={onReject}
        />,
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByText('Approve'));
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(onApprove).toHaveBeenCalledWith(77);
    });

    it('calls onReject with the deploy id when Reject is clicked', () => {
      const onApprove = mock(() => {});
      const onReject = mock(() => {});
      render(
        <DeployHistoryList
          records={[pendingRecord]}
          isLoading={false}
          stackName="plex"
          host="homeserver"
          onApprove={onApprove}
          onReject={onReject}
        />,
        { wrapper: createWrapper() },
      );
      fireEvent.click(screen.getByText('Reject'));
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onReject).toHaveBeenCalledWith(77);
    });

    it('disables both Approve and Reject while isApproving is true', () => {
      const onApprove = mock(() => {});
      const onReject = mock(() => {});
      render(
        <DeployHistoryList
          records={[pendingRecord]}
          isLoading={false}
          stackName="plex"
          host="homeserver"
          onApprove={onApprove}
          onReject={onReject}
          isApproving={true}
        />,
        { wrapper: createWrapper() },
      );
      const approveBtn = screen.getByText('Approve').closest('button') as HTMLButtonElement;
      const rejectBtn = screen.getByText('Reject').closest('button') as HTMLButtonElement;
      expect(approveBtn.disabled).toBe(true);
      expect(rejectBtn.disabled).toBe(true);
    });

    it('disables both Approve and Reject while isRejecting is true', () => {
      const onApprove = mock(() => {});
      const onReject = mock(() => {});
      render(
        <DeployHistoryList
          records={[pendingRecord]}
          isLoading={false}
          stackName="plex"
          host="homeserver"
          onApprove={onApprove}
          onReject={onReject}
          isRejecting={true}
        />,
        { wrapper: createWrapper() },
      );
      const approveBtn = screen.getByText('Approve').closest('button') as HTMLButtonElement;
      const rejectBtn = screen.getByText('Reject').closest('button') as HTMLButtonElement;
      expect(approveBtn.disabled).toBe(true);
      expect(rejectBtn.disabled).toBe(true);
    });

    it('does not show Approve/Reject for pending rows when handlers are not provided', () => {
      render(
        <DeployHistoryList
          records={[pendingRecord]}
          isLoading={false}
          stackName="plex"
          host="homeserver"
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.queryByText('Approve')).toBeNull();
      expect(screen.queryByText('Reject')).toBeNull();
      // The pending chip should still render to indicate awaiting state
      expect(screen.getByText('Pending approval')).toBeDefined();
    });
  });

});
