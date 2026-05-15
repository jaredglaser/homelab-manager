import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DockerContainerTableRow } from '@/types/docker';

mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: () => {} }),
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => 'https://icons.example.com/nginx.png',
  FALLBACK_ICON_URL: 'https://icons.example.com/fallback.png',
}));

mock.module('@/components/docker/IconPickerDialog', () => ({
  default: ({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (slug: string) => void }) =>
    open ? (
      <div data-testid="icon-picker">
        <button onClick={onClose}>close-picker</button>
        <button onClick={() => onSelect('nginx')}>select-nginx</button>
      </div>
    ) : null,
}));

mock.module('@/components/docker/ContainerStateChip', () => ({
  default: ({ state }: { state: string }) => <span data-testid="state-chip">{state}</span>,
}));

mock.module('@/hooks/usePulseIndicator', () => ({
  usePulseIndicator: () => ({
    indicatorRef: { current: null },
    pingRef: { current: null },
    dotRef: { current: null },
  }),
}));

const { default: ContainerNameCell } = await import('@/components/docker/ContainerNameCell');

const makeRow = (overrides: Partial<DockerContainerTableRow> = {}): DockerContainerTableRow => ({
  id: 'server1/abc123',
  type: 'container',
  hostName: 'server1',
  isStale: false,
  inventory: {
    host: 'server1',
    containerId: 'abc123',
    name: 'nginx',
    image: 'nginx:latest',
    state: 'running',
    status: 'Up 1 hour',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never,
  ...overrides,
});

describe('ContainerNameCell', () => {
  it('renders the container name', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={false}
        onIconChange={async () => {}}
      />,
    );
    screen.getByText('nginx');
  });

  it('renders state chip for non-running container', () => {
    const row = makeRow({ inventory: { ...makeRow().inventory, state: 'exited' } as never });
    render(
      <ContainerNameCell
        row={row}
        expanded={false}
        onIconChange={async () => {}}
      />,
    );
    screen.getByTestId('state-chip');
  });

  it('does not render state chip for running container', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={false}
        onIconChange={async () => {}}
      />,
    );
    expect(screen.queryByTestId('state-chip')).toBeNull();
  });

  it('renders settings icon button', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={false}
        onIconChange={async () => {}}
      />,
    );
    screen.getByLabelText('Change container icon');
  });

  it('opens icon picker when settings button clicked', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={true}
        onIconChange={async () => {}}
      />,
    );
    const settingsBtn = screen.getByLabelText('Change container icon');
    fireEvent.click(settingsBtn);
    screen.getByTestId('icon-picker');
  });

  it('closes icon picker when close button clicked', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={true}
        onIconChange={async () => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Change container icon'));
    fireEvent.click(screen.getByText('close-picker'));
    expect(screen.queryByTestId('icon-picker')).toBeNull();
  });

  it('calls onIconChange when an icon is selected', async () => {
    let calledWith: [string, string] | null = null;
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={true}
        onIconChange={async (entity, slug) => { calledWith = [entity, slug]; }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Change container icon'));
    fireEvent.click(screen.getByText('select-nginx'));
    expect(calledWith![1]).toBe('nginx');
  });

  it('renders history button when onOpenHistory is provided', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={false}
        onIconChange={async () => {}}
        onOpenHistory={() => {}}
      />,
    );
    screen.getByLabelText('View container history');
  });

  it('does not render history button when onOpenHistory is not provided', () => {
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={false}
        onIconChange={async () => {}}
      />,
    );
    expect(screen.queryByLabelText('View container history')).toBeNull();
  });

  it('calls onOpenHistory when history button is clicked', () => {
    let called = false;
    render(
      <ContainerNameCell
        row={makeRow()}
        expanded={true}
        onIconChange={async () => {}}
        onOpenHistory={() => { called = true; }}
      />,
    );
    fireEvent.click(screen.getByLabelText('View container history'));
    expect(called).toBe(true);
  });

  it('renders pulse indicator for restarting container', () => {
    const row = makeRow({ inventory: { ...makeRow().inventory, state: 'restarting' } as never });
    const { container } = render(
      <ContainerNameCell
        row={row}
        expanded={false}
        onIconChange={async () => {}}
      />,
    );
    // Pulse indicator div should be present (relative w-2 h-2)
    expect(container.querySelector('.w-2.h-2')).toBeTruthy();
  });
});
