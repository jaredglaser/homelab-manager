import { SwipeableDrawer } from '@mui/material';
import { DRAWER_ENTER_MS, DRAWER_EXIT_MS, DRAWER_EASING } from '@/lib/constants/ui-timing';

interface BottomDrawerProps {
  open: boolean;
  onClose: () => void;
  onExited?: () => void;
  children: React.ReactNode;
}

export default function BottomDrawer({ open, onClose, onExited, children }: Readonly<BottomDrawerProps>) {
  return (
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableScrollLock
      transitionDuration={{ enter: DRAWER_ENTER_MS, exit: DRAWER_EXIT_MS }}
      slotProps={{
        backdrop: {
          // Stop React synthetic event bubbling so portal clicks
          // don't propagate through the React tree to parent handlers
          // (e.g. row onClick toggling expansion in DataTable).
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
        },
        paper: {
          className:
            'rounded-t-2xl! rounded-b-none! bg-(--mui-palette-background-default)! max-h-[calc(100vh-60px)]!',
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
        <div className="w-10 h-1 rounded-full bg-(--mui-palette-divider)" />
      </div>
      {children}
    </SwipeableDrawer>
  );
}
