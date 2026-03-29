import BottomDrawer from '@/components/shared/BottomDrawer';
import ContainerHistoryPage from '@/components/docker/ContainerHistoryPage';

interface ContainerHistoryPanelProps {
  open: boolean;
  containerId: string;
  host: string;
  onClose: () => void;
  onExited?: () => void;
}

export default function ContainerHistoryPanel({
  open,
  containerId,
  host,
  onClose,
  onExited,
}: Readonly<ContainerHistoryPanelProps>) {
  return (
    <BottomDrawer open={open} onClose={onClose} onExited={onExited}>
      <ContainerHistoryPage
        key={`${host}/${containerId}`}
        containerId={containerId}
        host={host}
        initialMetrics="cpu,memory"
        onClose={onClose}
      />
    </BottomDrawer>
  );
}
