import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

mock.module('@/hooks/useFindings', () => ({
  useFindings: () => ({ findings: [], isConnected: true, error: null }),
}));

const { Route } = await import('@/routes/log-analysis');

describe('log-analysis route', () => {
  it('is not server rendered', () => {
    expect(Route.options.ssr).toBe(false);
  });

  it('renders the findings feed as its component', () => {
    const RouteComponent = Route.options.component!;
    render(<RouteComponent />);
    expect(screen.getByText('Findings')).toBeDefined();
    expect(screen.getByText('No findings yet.')).toBeDefined();
  });
});
