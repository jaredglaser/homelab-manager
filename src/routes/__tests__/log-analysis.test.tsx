import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('@/hooks/useFindings', () => ({
  useFindings: () => ({ findings: [], isConnected: true, error: null }),
}));

mock.module('@/hooks/useDockerInventory', () => ({
  useDockerInventory: () => ({ inventory: new Map() }),
}));

mock.module('@/hooks/useAuth', () => ({ useCanWrite: () => true }));

mock.module('@/components/findings/FeedbackMetrics', () => ({
  FeedbackMetrics: () => null,
}));

const { Route } = await import('@/routes/log-analysis');

describe('log-analysis route', () => {
  it('is not server rendered', () => {
    expect(Route.options.ssr).toBe(false);
  });

  it('renders the findings feed as its component', () => {
    const RouteComponent = Route.options.component!;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouteComponent />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Findings')).toBeDefined();
    expect(screen.getByText('No findings yet.')).toBeDefined();
  });
});
