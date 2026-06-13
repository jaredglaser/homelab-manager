import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const controlContainerMock = mock(() => Promise.resolve());

mock.module('@/data/docker/functions', () => ({
  controlContainer: controlContainerMock,
}));

const showToastMock = mock();

mock.module('@/hooks/toastAtom', () => ({
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

describe('ContainerActionButtons', () => {
  beforeEach(() => {
    controlContainerMock.mockClear();
    showToastMock.mockClear();
    controlContainerMock.mockImplementation(() => Promise.resolve());
  });

  describe('default (labeled) mode', () => {
    it('renders Start, Stop, and Restart buttons', () => {
      renderButtons({ isRunning: true });
      screen.getByText('Start');
      screen.getByText('Stop');
      screen.getByText('Restart');
    });

    it('disables Start when container is running', () => {
      renderButtons({ isRunning: true });
      expect((screen.getByText('Start').closest('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Start when container is not running', () => {
      renderButtons({ isRunning: false });
      expect((screen.getByText('Start').closest('button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('disables Stop and Restart when container is not running', () => {
      renderButtons({ isRunning: false });
      expect((screen.getByText('Stop').closest('button') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText('Restart').closest('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Stop and Restart when container is running', () => {
      renderButtons({ isRunning: true });
      expect((screen.getByText('Stop').closest('button') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByText('Restart').closest('button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('calls controlContainer with start action when Start is clicked', async () => {
      renderButtons({ isRunning: false });
      fireEvent.click(screen.getByText('Start').closest('button')!);
      await waitFor(() => expect(controlContainerMock).toHaveBeenCalledTimes(1));
      expect(controlContainerMock).toHaveBeenCalledWith({
        data: { host: 'server', containerId: 'abc123', action: 'start' },
      });
    });

    it('shows success toast after successful stop', async () => {
      renderButtons({ isRunning: true });
      fireEvent.click(screen.getByText('Stop').closest('button')!);
      await waitFor(() => expect(showToastMock).toHaveBeenCalled());
      expect(showToastMock).toHaveBeenCalledWith('Container stopped', 'success');
    });

    it('shows error toast when mutation fails', async () => {
      controlContainerMock.mockImplementation(() => Promise.reject(new Error('connection refused')));
      renderButtons({ isRunning: true });
      fireEvent.click(screen.getByText('Restart').closest('button')!);
      await waitFor(() => expect(showToastMock).toHaveBeenCalled());
      expect(showToastMock.mock.calls[0][1]).toBe('error');
    });
  });

  describe('compact (icon-only) mode', () => {
    it('does not render text labels', () => {
      renderButtons({ isRunning: true, compact: true });
      expect(screen.queryByText('Start')).toBeNull();
      expect(screen.queryByText('Stop')).toBeNull();
      expect(screen.queryByText('Restart')).toBeNull();
    });

    it('renders aria-labeled icon buttons', () => {
      renderButtons({ isRunning: true, compact: true });
      screen.getByLabelText('Start container');
      screen.getByLabelText('Stop container');
      screen.getByLabelText('Restart container');
    });
  });
});
