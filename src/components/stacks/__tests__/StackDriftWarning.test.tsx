import { describe, expect, it } from 'bun:test';
import { render, screen } from '@testing-library/react';
import StackDriftWarning from '@/components/stacks/StackDriftWarning';
import type { StackDriftItem } from '@/types/stacks';

const item: StackDriftItem = {
  kind: 'content',
  host: 'alpha',
  stack: 'plex',
  repoComposeHash: 'repo-hash',
  agentComposeHash: 'agent-hash',
  latestDeployStatus: 'succeeded',
};

describe('StackDriftWarning', () => {
  it('renders a warning naming the drift kind', () => {
    render(<StackDriftWarning item={item} />);
    expect(screen.getByText(/content drift/i)).toBeDefined();
  });

  it('renders no resolution controls', () => {
    render(<StackDriftWarning item={item} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
