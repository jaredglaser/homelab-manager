import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentType } from 'react';

// Provide a mock for the StacksContext
const mockContextValue = {
  stacks: [
    { name: 'app-web', host: 'server-1', syncStatus: 'in_sync', deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 2, icon: 'nginx' },
    { name: 'app-db', host: 'server-1', syncStatus: 'pending', deployMode: 'manual', lastDeployAt: null, lastDeployStatus: null, containerCount: 1, icon: null },
    { name: 'monitoring', host: 'server-2', syncStatus: 'in_sync', deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 3, icon: 'grafana' },
  ],
  statusMap: new Map(),
  hosts: ['server-1', 'server-2'],
  isLoading: false,
};

mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: any) => {
    const items = Array.from({ length: count }, (_, i) => ({
      index: i,
      key: String(i),
      start: i * estimateSize(i),
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * 36,
      measureElement: () => {},
    };
  },
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: (slug: string) => slug ? `https://icons.test/${slug}.png` : null,
}));

mock.module('@/components/stacks/stacks-context', () => ({
  useStacksContext: () => mockContextValue,
}));

mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to, params, className, activeProps, ...rest }: any) => (
    <a href={to} data-params={JSON.stringify(params)} className={className} {...rest}>
      {children}
    </a>
  ),
}));

let StackNav: ComponentType<{ onCreateClick: () => void }>;

beforeAll(async () => {
  const mod = await import('../StackNav');
  StackNav = mod.default;
});

describe('StackNav', () => {
  it('renders the Stacks header', () => {
    render(<StackNav onCreateClick={() => {}} />);
    expect(screen.getByText('Stacks')).toBeDefined();
  });

  it('renders the create button', () => {
    render(<StackNav onCreateClick={() => {}} />);
    expect(screen.getByLabelText('Create stack')).toBeDefined();
  });

  it('calls onCreateClick when create button is clicked', () => {
    const onCreateClick = mock(() => {});
    render(<StackNav onCreateClick={onCreateClick} />);
    fireEvent.click(screen.getByLabelText('Create stack'));
    expect(onCreateClick).toHaveBeenCalledTimes(1);
  });

  it('renders host headers sorted alphabetically', () => {
    render(<StackNav onCreateClick={() => {}} />);
    const hosts = screen.getAllByText(/server-/);
    expect(hosts[0].textContent).toBe('server-1');
    expect(hosts[1].textContent).toBe('server-2');
  });

  it('renders stack names under their hosts', () => {
    render(<StackNav onCreateClick={() => {}} />);
    expect(screen.getByText('app-db')).toBeDefined();
    expect(screen.getByText('app-web')).toBeDefined();
    expect(screen.getByText('monitoring')).toBeDefined();
  });

  it('renders stacks sorted alphabetically within each host', () => {
    render(<StackNav onCreateClick={() => {}} />);
    const allLinks = screen.getAllByRole('link');
    const stackLinks = allLinks.filter((l) => {
      const params = l.getAttribute('data-params');
      return params && params.includes('stackName');
    });
    // server-1 stacks: app-db before app-web
    expect(stackLinks[0].textContent).toContain('app-db');
    expect(stackLinks[1].textContent).toContain('app-web');
    // server-2 stacks: monitoring
    expect(stackLinks[2].textContent).toContain('monitoring');
  });

  it('renders host links pointing to host settings route', () => {
    render(<StackNav onCreateClick={() => {}} />);
    const hostLinks = screen.getAllByRole('link').filter((l) =>
      l.getAttribute('href')?.includes('/stacks/host/'),
    );
    expect(hostLinks).toHaveLength(2);
  });

  it('renders stack links pointing to stack editor route', () => {
    render(<StackNav onCreateClick={() => {}} />);
    const stackLinks = screen.getAllByRole('link').filter((l) =>
      l.getAttribute('href')?.includes('/stacks/$stackName'),
    );
    expect(stackLinks).toHaveLength(3);
  });

  it('renders icon images for stacks with icons', () => {
    const { container } = render(<StackNav onCreateClick={() => {}} />);
    const images = container.querySelectorAll('img');
    // app-web has nginx icon, monitoring has grafana icon
    expect(images).toHaveLength(2);
  });

  it('renders letter fallback for stacks without icons', () => {
    render(<StackNav onCreateClick={() => {}} />);
    // app-db has no icon, should show 'A' fallback
    expect(screen.getByText('A')).toBeDefined();
  });

  it('shows container count when > 0', () => {
    // app-web has 2 containers, app-db has 1, monitoring has 3
    render(<StackNav onCreateClick={() => {}} />);
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });
});
