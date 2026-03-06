import { SwipeableDrawer } from '@mui/material';
import ContainerHistoryPage from '@/components/docker/ContainerHistoryPage';
import { DRAWER_ENTER_MS, DRAWER_EXIT_MS, DRAWER_EASING } from '@/lib/constants/ui-timing';

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
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableScrollLock
      transitionDuration={{ enter: DRAWER_ENTER_MS, exit: DRAWER_EXIT_MS }}
      slotProps={{
        paper: {
          className:
            '!rounded-t-2xl !rounded-b-none !bg-[var(--mui-palette-background-default)] !max-h-[calc(100vh-60px)]',
        },
        transition: {
          onExited,
          easing: {
            enter: DRAWER_EASING,
            exit: DRAWER_EASING,
          },
        },
      }}
    >
      {/* Drag handle */}
      <div className="flex justify-center pt-3 pb-1 select-none">
        <div className="w-10 h-1 rounded-full bg-[var(--mui-palette-divider)]" />
      </div>
      <ContainerHistoryPage
        key={`${host}/${containerId}`}
        containerId={containerId}
        host={host}
        initialMetrics="cpu,memory"
        onClose={onClose}
      />
    </SwipeableDrawer>
  );
}
