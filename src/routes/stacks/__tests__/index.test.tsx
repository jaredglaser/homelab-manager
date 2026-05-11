import { describe, it, expect, mock, beforeAll, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentType } from 'react';

const mockNavigate = mock(() => {});
const mockCreateStack = mock(() => Promise.resolve({}));

let mockListContext = {
  stacks: [] as { host: string; name: string }[],
  hosts: ['server-1'] as string[],
  isLoading: false,
};
let mockStatusMap = new Map<string, { containers: { status: string }[] }>();

mock.module('@/components/stacks/stacks-context', () => ({
  useStackListContext: () => mockListContext,
  useStackStatusContext: () => ({ statusMap: mockStatusMap, deployVersion: 0 }),
}));

mock.module('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => opts,
  useNavigate: () => mockNavigate,
}));

mock.module('@/data/stacks/functions', () => ({
  createStack: mockCreateStack,
}));

let StacksOverview: ComponentType;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeAll(async () => {
  const mod = await import('../index');
  StacksOverview = (mod.Route as any).component;
});

beforeEach(() => {
  mockNavigate.mockClear();
  mockCreateStack.mockClear();
  mockListContext = { stacks: [], hosts: ['server-1'], isLoading: false };
  mockStatusMap = new Map();
});

describe('StacksOverview', () => {
  it('renders loading state', () => {
    mockListContext = { stacks: [], hosts: [], isLoading: true };
    render(<StacksOverview />, { wrapper: createWrapper() });
    expect(screen.getByText('Loading stacks...')).toBeDefined();
  });

  it('renders empty state with message and New stack button', () => {
    render(<StacksOverview />, { wrapper: createWrapper() });
    expect(screen.getByText('No stacks yet.')).toBeDefined();
    expect(screen.getByRole('button', { name: /New stack/i })).toBeDefined();
  });

  it('renders host summary cards and New stack button when stacks exist', () => {
    mockListContext = {
      stacks: [{ host: 'server-1', name: 'app-web' }],
      hosts: ['server-1'],
      isLoading: false,
    };
    render(<StacksOverview />, { wrapper: createWrapper() });
    expect(screen.getByText('server-1')).toBeDefined();
    expect(screen.getByRole('button', { name: /New stack/i })).toBeDefined();
  });

  it('clicking New stack opens the create dialog', () => {
    render(<StacksOverview />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /New stack/i }));
    expect(screen.getByLabelText('Stack Name')).toBeDefined();
  });

  it('openDialog clears a prior error before reopening', async () => {
    mockCreateStack.mockRejectedValueOnce(new Error('stack already exists'));
    const { container } = render(<StacksOverview />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: /New stack/i }));
    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'mystack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    await waitFor(() => expect(screen.getByText('stack already exists')).toBeDefined());

    // MUI Modal sets aria-hidden on background content while the dialog is open, so getByRole
    // can't reach the background "New stack" button. Use querySelector to call openDialog()
    // and verify it resets createError to null.
    const bgBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('New stack'),
    );
    fireEvent.click(bgBtn!);

    expect(screen.queryByText('stack already exists')).toBeNull();
  });

  it('shows mutation error message in the dialog', async () => {
    mockCreateStack.mockRejectedValueOnce(new Error('network error'));
    render(<StacksOverview />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: /New stack/i }));
    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'mystack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));

    await waitFor(() => expect(screen.getByText('network error')).toBeDefined());
  });

  it('converts non-Error rejections to string for display', async () => {
    mockCreateStack.mockRejectedValueOnce('plain string error');
    render(<StacksOverview />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: /New stack/i }));
    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'mystack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));

    await waitFor(() => expect(screen.getByText('plain string error')).toBeDefined());
  });

  it('navigates to the new stack on successful creation', async () => {
    render(<StacksOverview />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: /New stack/i }));
    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'new-app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/stacks/$stackName',
        params: { stackName: 'new-app' },
      }),
    );
  });

  it('counts stacks and running containers per host', () => {
    mockListContext = {
      stacks: [
        { host: 'server-1', name: 'app-web' },
        { host: 'server-1', name: 'app-db' },
        { host: 'server-2', name: 'monitoring' },
      ],
      hosts: ['server-1', 'server-2'],
      isLoading: false,
    };
    mockStatusMap = new Map([
      ['server-1/app-web', { containers: [{ status: 'running' }] }],
      ['server-1/app-db', { containers: [{ status: 'stopped' }] }],
      ['server-2/monitoring', { containers: [{ status: 'running' }] }],
    ]);
    render(<StacksOverview />, { wrapper: createWrapper() });

    expect(screen.getByText(/2 stacks/)).toBeDefined();
    expect(screen.getByText(/1 stack /)).toBeDefined();
  });

  it('uses singular stack label for a host with exactly one stack', () => {
    mockListContext = {
      stacks: [{ host: 'server-1', name: 'only-app' }],
      hosts: ['server-1'],
      isLoading: false,
    };
    render(<StacksOverview />, { wrapper: createWrapper() });
    expect(screen.getByText(/1 stack /)).toBeDefined();
    expect(screen.queryByText(/1 stacks/)).toBeNull();
  });
});
