import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import type { StackDriftItem } from '@/types/stacks';
import {
  StackListContext,
  StackStatusContext,
  type StackListContextValue,
  type StackStatusContextValue,
} from '@/components/stacks/stacks-context';

const mockStacks: StackListContextValue['stacks'] = [
  { name: 'app-web', host: 'server-1', syncStatus: 'in_sync', deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 2, icon: 'nginx' },
  { name: 'app-db', host: 'server-1', syncStatus: 'pending', deployMode: 'manual', lastDeployAt: null, lastDeployStatus: null, containerCount: 1, icon: null },
  { name: 'monitoring', host: 'server-2', syncStatus: 'in_sync', deployMode: 'auto', lastDeployAt: null, lastDeployStatus: null, containerCount: 3, icon: 'grafana' },
];

const listValue: StackListContextValue = {
  stacks: mockStacks,
  hosts: ['server-1', 'server-2'],
  isLoading: false,
};

const statusValue: StackStatusContextValue = {
  statusMap: new Map(),
  deployVersion: 0,
};

mock.module('@/lib/utils/icon-resolver', () => ({
  AVAILABLE_ICONS: ['nginx', 'grafana', 'docker'] as string[],
  FALLBACK_ICON_URL: 'https://icons.test/docker.svg',
  extractImageBaseName: (image: string) => image.split(':')[0].split('/').pop() ?? image,
  hasIcon: (slug: string) => ['nginx', 'grafana', 'docker'].includes(slug),
  findIconContaining: (term: string) => ['nginx', 'grafana', 'docker'].find((s) => s.includes(term)) ?? null,
  getIconUrl: (slug: string) => slug ? `https://icons.test/${slug}.png` : null,
}));

mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to, params, className, activeProps: _activeProps, ...rest }: { children?: ReactNode; to: string; params?: Record<string, unknown>; className?: string; activeProps?: unknown; [k: string]: unknown }) => (
    <a href={to} data-params={JSON.stringify(params)} className={className} {...rest}>
      {children}
    </a>
  ),
  // `@tanstack/react-start`'s createServerFn imports these at runtime in
  // concurrent test files. Provide no-op stubs so unrelated tests don't
  // crash with a cryptic "Export not found" error.
  isRedirect: () => false,
  useRouter: () => ({ navigate: () => {}, invalidate: () => {} }),
}));

let StackNav: ComponentType<{ onCreateClick: () => void; driftByKey?: Map<string, StackDriftItem> }>;

const driftByKey = new Map<string, StackDriftItem>([
  ['server-1/app-db', {
    host: 'server-1',
    stack: 'app-db',
    kind: 'ghost',
    repoComposeHash: 'repo-hash',
    latestDeployStatus: 'succeeded',
  }],
]);

beforeAll(async () => {
  const mod = await import('../StackNav');
  StackNav = mod.default;
});

// Wrap in real context providers so we don't have to mock.module the context
// module. Mocking the context module globally pollutes other tests that import
// the same hooks (e.g. stacks-context.test.ts) because bun's mock.module is
// process-scoped, not test-file-scoped.
function renderWithContexts(ui: ReactNode) {
  return render(
    <StackListContext value={listValue}>
      <StackStatusContext value={statusValue}>
        {ui}
      </StackStatusContext>
    </StackListContext>,
  );
}

describe('StackNav', () => {
  it('renders the Stacks header', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    expect(screen.getByText('Stacks')).toBeDefined();
  });

  it('renders the create button', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    expect(screen.getByLabelText('Create stack')).toBeDefined();
  });

  it('calls onCreateClick when create button is clicked', () => {
    const onCreateClick = mock(() => {});
    renderWithContexts(<StackNav onCreateClick={onCreateClick} driftByKey={driftByKey} />);
    fireEvent.click(screen.getByLabelText('Create stack'));
    expect(onCreateClick).toHaveBeenCalledTimes(1);
  });

  it('renders host headers sorted alphabetically', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    const hosts = screen.getAllByText(/server-/);
    expect(hosts[0].textContent).toBe('server-1');
    expect(hosts[1].textContent).toBe('server-2');
  });

  it('renders stack names under their hosts', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    expect(screen.getByText('app-db')).toBeDefined();
    expect(screen.getByText('app-web')).toBeDefined();
    expect(screen.getByText('monitoring')).toBeDefined();
  });

  it('renders stacks sorted alphabetically within each host', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    const allLinks = screen.getAllByRole('link');
    const stackLinks = allLinks.filter((l) => {
      const params = l.getAttribute('data-params');
      return params && params.includes('stackName');
    });
    expect(stackLinks[0].textContent).toContain('app-db');
    expect(stackLinks[1].textContent).toContain('app-web');
    expect(stackLinks[2].textContent).toContain('monitoring');
  });

  it('renders host links pointing to host settings route with correct params', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    const hostLinks = screen.getAllByRole('link').filter((l) =>
      l.getAttribute('href')?.includes('/stacks/host/'),
    );
    expect(hostLinks).toHaveLength(2);
    const hostParams = hostLinks.map((l) => JSON.parse(l.getAttribute('data-params')!));
    expect(hostParams[0]).toEqual(expect.objectContaining({ hostName: 'server-1' }));
    expect(hostParams[1]).toEqual(expect.objectContaining({ hostName: 'server-2' }));
  });

  it('renders stack links pointing to stack editor route with correct params', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    const stackLinks = screen.getAllByRole('link').filter((l) =>
      l.getAttribute('href')?.includes('/stacks/$stackName'),
    );
    expect(stackLinks).toHaveLength(3);
    const stackParams = stackLinks.map((l) => JSON.parse(l.getAttribute('data-params')!));
    expect(stackParams[0]).toEqual(expect.objectContaining({ stackName: 'app-db' }));
    expect(stackParams[1]).toEqual(expect.objectContaining({ stackName: 'app-web' }));
    expect(stackParams[2]).toEqual(expect.objectContaining({ stackName: 'monitoring' }));
  });

  it('renders icon images for stacks with icons', () => {
    const { container } = renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
  });

  it('renders letter fallback for stacks without icons', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    expect(screen.getByText('A')).toBeDefined();
  });

  it('shows container count when > 0', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders a drift marker for stacks with drift', () => {
    renderWithContexts(<StackNav onCreateClick={() => {}} driftByKey={driftByKey} />);
    expect(screen.getByLabelText('Drift detected for app-db')).toBeDefined();
  });
});
