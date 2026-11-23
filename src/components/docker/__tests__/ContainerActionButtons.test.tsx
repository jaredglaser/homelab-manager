import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { findOpenTooltip, roleReasonOf, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockModule } from '@/lib/test/mock-module';

const controlContainerMock = mock(() => Promise.resolve());

mockModule<typeof import('@/data/docker/functions')>('@/data/docker/functions', (real) => ({ ...real, 
  controlContainer: controlContainerMock,
}));

const showToastMock = mock();

mockModule<typeof import('@/hooks/toastAtom')>('@/hooks/toastAtom', (real) => ({ ...real, 
  useToast: () => ({ showToast: showToastMock }),
}));

const { default: ContainerActionButtons } = await import('@/components/docker/ContainerActionButtons');

function renderButtons(props: { isRunning: boolean; compact?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContainerActionButtons containerId="abc123" host="server" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  seedSession('admin');
});

describe('ContainerActionButtons', () => {
  beforeEach(() => {
    controlContainerMock.mockClear();
    showToastMock.mockClear();
    controlContainerMock.mockImplementation(() => Promise.resolve());
  });

  describe('control actions', () => {
    it('renders Start, Stop, and Restart buttons', () => {
      renderButtons({ isRunning: true });
      screen.getByLabelText('Start container');
      screen.getByLabelText('Stop container');
      screen.getByLabelText('Restart container');
    });

    it('disables Start when container is running', () => {
      renderButtons({ isRunning: true });
      expect((screen.getByLabelText('Start container') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Start when container is not running', () => {
      renderButtons({ isRunning: false });
      expect((screen.getByLabelText('Start container') as HTMLButtonElement).disabled).toBe(false);
    });

    it('disables Stop and Restart when container is not running', () => {
      renderButtons({ isRunning: false });
      expect((screen.getByLabelText('Stop container') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText('Restart container') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Stop and Restart when container is running', () => {
      renderButtons({ isRunning: true });
      expect((screen.getByLabelText('Stop container') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByLabelText('Restart container') as HTMLButtonElement).disabled).toBe(false);
    });

    it('calls controlContainer with start action when Start is clicked', async () => {
      renderButtons({ isRunning: false });
      fireEvent.click(screen.getByLabelText('Start container'));
      await waitFor(() => expect(controlContainerMock).toHaveBeenCalledTimes(1));
      expect(controlContainerMock).toHaveBeenCalledWith({
        data: { host: 'server', containerId: 'abc123', action: 'start' },
      });
    });

    it('shows success toast after successful stop', async () => {
      renderButtons({ isRunning: true });
      fireEvent.click(screen.getByLabelText('Stop container'));
      await waitFor(() => expect(showToastMock).toHaveBeenCalled());
      expect(showToastMock).toHaveBeenCalledWith('Container stopped', 'success');
    });

    it('shows error toast when mutation fails', async () => {
      controlContainerMock.mockImplementation(() => Promise.reject(new Error('connection refused')));
      renderButtons({ isRunning: true });
      fireEvent.click(screen.getByLabelText('Restart container'));
      await waitFor(() => expect(showToastMock).toHaveBeenCalled());
      expect(showToastMock.mock.calls[0][1]).toBe('error');
    });
  });

  describe('roles', () => {
    const labels = ['Start container', 'Stop container', 'Restart container'];

    it.each([true, false])('shows a viewer Start, Stop and Restart disabled with the role reason, and clicking them calls nothing (running: %p)', async (isRunning) => {
      seedSession('viewer');
      renderButtons({ isRunning });
      const user = setupUser();
      for (const label of labels) {
        const button = screen.getByLabelText(label);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(roleReasonOf(button)).toBe(VIEWER_DENIED_COPY);
        fireEvent.click(button);
      }
      await user.hover(screen.getByLabelText(isRunning ? 'Stop container' : 'Start container'));
      expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
      expect(controlContainerMock).not.toHaveBeenCalled();
    });

    it.each(['admin', 'operator'] as const)('lets an %s start, stop and restart a container', async (role) => {
      seedSession(role);
      const { unmount } = renderButtons({ isRunning: false });
      expect(screen.getByLabelText('Start container').getAttribute('aria-disabled')).toBeNull();
      fireEvent.click(screen.getByLabelText('Start container'));
      await waitFor(() => expect(controlContainerMock).toHaveBeenCalledTimes(1));
      unmount();

      renderButtons({ isRunning: true });
      fireEvent.click(screen.getByLabelText('Stop container'));
      await waitFor(() => expect(controlContainerMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByLabelText<HTMLButtonElement>('Restart container').disabled).toBe(false));
      fireEvent.click(screen.getByLabelText('Restart container'));
      await waitFor(() => expect(controlContainerMock).toHaveBeenCalledTimes(3));
      expect(controlContainerMock.mock.calls.map((call) => (call as unknown as [{ data: { action: string } }])[0].data.action)).toEqual(['start', 'stop', 'restart']);
    });
  });

  describe('compact (icon-only) mode', () => {
    it('does not render text labels', () => {
      renderButtons({ isRunning: true, compact: true });
      expect(screen.queryByText('Start')).toBeNull();
      expect(screen.queryByText('Stop')).toBeNull();
      expect(screen.queryByText('Restart')).toBeNull();
    });
  });
});
