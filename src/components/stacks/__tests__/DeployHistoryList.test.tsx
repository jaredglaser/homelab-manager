import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
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
    logs: 'Error: something went wrong',
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
  },
];

describe('DeployHistoryList', () => {
  it('renders loading skeletons when isLoading is true', () => {
    const { container } = render(<DeployHistoryList records={[]} isLoading={true} />);
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBe(3);
  });

  it('renders empty message when no records', () => {
    render(<DeployHistoryList records={[]} isLoading={false} />);
    expect(screen.getByText('No deploy history.')).toBeDefined();
  });

  it('renders deploy records with commit sha', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    expect(screen.getByText('a1b2c3d')).toBeDefined();
    expect(screen.getByText('f6e5d4c')).toBeDefined();
  });

  it('renders status badges', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    expect(screen.getByText('Succeeded')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders trigger labels', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    expect(screen.getByText('UI')).toBeDefined();
    expect(screen.getByText('Git Push')).toBeDefined();
  });

  it('expands log output on click', () => {
    render(<DeployHistoryList records={mockRecords} isLoading={false} />);
    fireEvent.click(screen.getByText('a1b2c3d'));
    expect(screen.getByText('Deploy output here')).toBeDefined();
  });
});
