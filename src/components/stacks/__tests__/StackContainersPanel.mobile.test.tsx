import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import type { StackContainer } from '@/types/stacks';
import { MOBILE_BREAKPOINT } from '@/lib/constants/breakpoints';

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render: el }: { render: ReactElement }) => el,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module('sonner', () => ({
  toast: { success: () => {}, error: () => {} },
}));

mock.module('@/data/stacks/functions', () => ({
  controlStack: mock(async () => {}),
}));

mock.module('@/components/docker/ContainerLogViewer', () => ({
  default: ({ wordWrap }: { wordWrap: boolean }) => (
    <div data-testid="log-viewer" data-wordwrap={String(wordWrap)} />
  ),
}));

mock.module('@/components/docker/ContainerTerminal', () => ({
  default: ({ wordWrap }: { wordWrap: boolean }) => (
    <div data-testid="terminal-viewer" data-wordwrap={String(wordWrap)} />
  ),
}));

mock.module('@/hooks/useDockerSettings', () => ({
  useDockerSettings: () => ({
    getContainerShell: () => undefined,
    setContainerShell: () => {},
  }),
}));

mock.module('@/lib/constants/demo', () => ({ IS_DEMO_MODE: false }));

const { default: StackContainersPanel } = await import('@/components/stacks/StackContainersPanel');

const containers: StackContainer[] = [
  { id: 'abc123', name: 'plex-web-1', status: 'running', image: 'plexinc/pms-docker', service: 'web', ports: [], mounts: [] },
];

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StackContainersPanel
        containers={containers}
        stackName="plex"
        host="server1"
        onRecreate={() => {}}
        isDeploying={false}
      />
    </QueryClientProvider>,
  );
}

describe('StackContainersPanel below the lg breakpoint', () => {
  it('wraps log output instead of scrolling it sideways in a phone-width dialog', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(screen.getByTestId('log-viewer').getAttribute('data-wordwrap')).toBe('true');
  });

  it('wraps terminal output too', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('terminal-viewer').getAttribute('data-wordwrap')).toBe('true');
  });

  it('lets the log dialog fill the viewport', () => {
    const { baseElement } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    const popup = baseElement.querySelector('[data-slot="dialog-content"]');
    expect(popup?.className).toContain('h-[calc(100dvh-16px)]');
    expect(popup?.className).toContain('lg:h-[70vh]');
  });
});
