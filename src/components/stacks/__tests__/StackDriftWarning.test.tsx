import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackDriftItem } from '@/types/stacks';
import { STACKS_QUERY_KEY, STACK_DRIFT_QUERY_KEY } from '@/lib/constants/stacks-keys';

const mockResolveDrift = mock(() => Promise.resolve({}));

mock.module('@/data/stacks/functions', () => ({
  resolveDrift: mockResolveDrift,
}));

const { default: StackDriftWarning } = await import('@/components/stacks/StackDriftWarning');

const item: StackDriftItem = {
  kind: 'content',
  host: 'alpha',
  stack: 'plex',
  repoComposeHash: 'repo-hash',
  agentComposeHash: 'agent-hash',
  latestDeployStatus: 'succeeded',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
  return { Wrapper, queryClient };
}

function renderWarning() {
  const { Wrapper, queryClient } = createWrapper();
  return { ...render(<StackDriftWarning item={item} />, { wrapper: Wrapper }), queryClient };
}

describe('StackDriftWarning', () => {
  it('renders a warning naming the drift kind', () => {
    renderWarning();
    expect(screen.getByText(/content drift/i)).toBeDefined();
  });

  it('renders the allowed resolutions for the drift kind', () => {
    renderWarning();
    expect(screen.getAllByRole('button').map((btn) => btn.textContent)).toEqual([
      'Redeploy repo version',
      'Adopt host version',
    ]);
  });

  it('requires confirmation naming the host, stack and what is overwritten', async () => {
    renderWarning();
    fireEvent.click(screen.getByRole('button', { name: 'Redeploy repo version' }));
    await screen.findByRole('dialog');
    expect(screen.getByText(/Redeploy repo version: alpha\/plex\?/i)).toBeDefined();
    expect(screen.getByText(/divergent compose file on alpha is overwritten/i)).toBeDefined();
    expect(screen.getByText(/\.drift-recovery/)).toBeDefined();
    expect(mockResolveDrift).not.toHaveBeenCalled();
  });

  it('resolves only after the confirmation is accepted', async () => {
    renderWarning();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt host version' }));
    await screen.findByRole('dialog');
    expect(mockResolveDrift).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Adopt host version' }));
    await waitFor(() =>
      expect(mockResolveDrift).toHaveBeenCalledWith({
        data: { host: 'alpha', stack: 'plex', kind: 'content', resolution: 'trust_agent' },
      }),
    );
  });

  it('refreshes the drift report when a resolution fails, since the host may already have changed', async () => {
    mockResolveDrift.mockImplementationOnce(() => Promise.reject(new Error('teardown failed')));
    const { queryClient } = renderWarning();
    const invalidated: unknown[] = [];
    queryClient.invalidateQueries = ((filters: { queryKey: unknown }) => {
      invalidated.push(filters.queryKey);
      return Promise.resolve();
    }) as typeof queryClient.invalidateQueries;

    fireEvent.click(screen.getByRole('button', { name: 'Adopt host version' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Adopt host version' }));

    await waitFor(() => expect(invalidated).toEqual([STACK_DRIFT_QUERY_KEY, STACKS_QUERY_KEY]));
  });
});
