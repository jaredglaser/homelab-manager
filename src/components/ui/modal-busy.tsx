import { createContext, useContext } from 'react';

const ModalBusyContext = createContext(false);

export const ModalBusyProvider = ModalBusyContext;

export function useModalBusy(): boolean {
  return useContext(ModalBusyContext);
}

export interface ModalBusyProps {
  /** Blocks every user-initiated close while true. Pass the condition that disables the footer buttons. */
  busy?: boolean;
}

interface CloseDetails {
  reason: string;
  cancel: () => void;
}

/** open={false} from the parent never reaches onOpenChange, and actionsRef.close() reports imperative-action, so both still close a busy modal. */
export function guardOpenChange<D extends CloseDetails>(
  busy: boolean,
  onOpenChange: ((open: boolean, details: D) => void) | undefined,
): (open: boolean, details: D) => void {
  return (open, details) => {
    if (busy && !open && details.reason !== 'imperative-action') {
      details.cancel();
      return;
    }
    onOpenChange?.(open, details);
  };
}
