import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode, type Ref } from 'react';

type ModalKind = 'Dialog' | 'AlertDialog' | 'Sheet';

interface ModalEntry {
  kind: ModalKind;
  open: boolean;
  popup: HTMLElement | null;
}

interface ModalRoot {
  busy: boolean;
  entry: ModalEntry;
}

const entries = new Set<ModalEntry>();

const ModalRootContext = createContext<ModalRoot | null>(null);
const ModalBusyContext = createContext(false);

export const ModalRootProvider = ModalRootContext;

export function useModalBusy(): boolean {
  return useContext(ModalBusyContext);
}

export interface ModalBusyProps {
  /** Blocks every user-initiated close while true and disables every Button inside the popup. Pass the in-flight condition. */
  busy?: boolean;
}

interface CloseDetails {
  reason: string;
  isCanceled: boolean;
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

interface RootOptions<D extends CloseDetails> {
  kind: ModalKind;
  busy: boolean;
  open: boolean | undefined;
  defaultOpen: boolean | undefined;
  onOpenChange: ((open: boolean, details: D) => void) | undefined;
}

export function useModalRoot<D extends CloseDetails>({ kind, busy, open, defaultOpen, onOpenChange }: RootOptions<D>) {
  const [entry] = useState<ModalEntry>(() => ({ kind, open: false, popup: null }));
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;

  useLayoutEffect(() => {
    entry.open = isOpen;
  }, [entry, isOpen]);

  useEffect(() => {
    entries.add(entry);
    return () => {
      entries.delete(entry);
    };
  }, [entry]);

  const guarded = guardOpenChange(busy, onOpenChange);
  const handleOpenChange = (next: boolean, details: D) => {
    guarded(next, details);
    if (open === undefined && !details.isCanceled) setUncontrolledOpen(next);
  };
  const value = useMemo(() => ({ busy, entry }), [busy, entry]);
  return { value, onOpenChange: handleOpenChange };
}

const labelOf = (entry: ModalEntry) => {
  const title = entry.popup?.querySelector('[data-slot$="-title"]')?.textContent;
  return title ? `${entry.kind} "${title}"` : entry.kind;
};

export function useModalPopup(forwardedRef: Ref<HTMLDivElement> | undefined) {
  const root = useContext(ModalRootContext);
  const entry = root?.entry;

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (entry) entry.popup = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [entry, forwardedRef],
  );

  return ref;
}

/** Only one modal may be open at a time. Mounting inside an open popup logs instead of throwing, so a later modal host can replace it. */
export function ModalBusyScope({ children }: Readonly<{ children: ReactNode }>) {
  const root = useContext(ModalRootContext);
  const entry = root?.entry;

  useEffect(() => {
    if (!entry?.open) return;
    for (const other of entries) {
      if (other !== entry && other.open) {
        console.error(`Two modals are open at once: ${labelOf(other)} and ${labelOf(entry)}. Open one modal at a time.`);
      }
    }
  }, [entry]);

  return <ModalBusyContext value={root?.busy ?? false}>{children}</ModalBusyContext>;
}
