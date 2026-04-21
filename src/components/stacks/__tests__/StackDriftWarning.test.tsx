import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import StackDriftWarning from '../StackDriftWarning';
import type { StackDriftItem } from '@/types/stacks';

const item: StackDriftItem = {
  host: 'alpha',
  stack: 'plex',
  kind: 'content',
  repoComposeHash: 'repo-hash',
  agentComposeHash: 'agent-hash',
  latestDeployStatus: 'failed',
};

describe('StackDriftWarning', () => {
  it('renders nothing when no drift item is provided', () => {
    const { container } = render(
      <StackDriftWarning item={null} isResolving={false} onResolve={() => {}} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders a warning with the drift kind', () => {
    render(<StackDriftWarning item={item} isResolving={false} onResolve={() => {}} />);
    expect(screen.getByText(/content drift/i)).toBeDefined();
  });

  it('calls onResolve for allowed actions', () => {
    const onResolve = mock(() => {});
    render(<StackDriftWarning item={item} isResolving={false} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Trust Repo' }));
    expect(onResolve).toHaveBeenCalledWith(item, 'trust_repo');
  });
});
