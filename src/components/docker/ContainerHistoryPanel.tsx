import { Drawer } from '@mui/material';
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
}: ContainerHistoryPanelProps) {
  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      transitionDuration={{ enter: 400, exit: 300 }}
      slotProps={{
        paper: {
          className:
            '!rounded-t-2xl !rounded-b-none !bg-[var(--mui-palette-background-default)] !max-h-[calc(100vh-60px)]',
        },
        transition: {
          onExited,
          easing: {
            enter: 'cubic-bezier(0.32, 0.72, 0, 1)',
            exit: 'cubic-bezier(0.32, 0.72, 0, 1)',
          },
        },
      }}
    >
      {/* Drag handle */}
      <div className="flex justify-center pt-3 pb-1 select-none">
        <div className="w-10 h-1 rounded-full bg-neutral-400/50" />
      </div>
      <ContainerHistoryPage
        key={`${host}/${containerId}`}
        containerId={containerId}
        host={host}
        initialMetrics="cpu,memory"
        onClose={onClose}
      />
    </Drawer>
  );
}
