import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackDeployRecord } from '@/types/stacks';
import DeployHistoryList from '../DeployHistoryList';

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
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
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
});
