import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, type ReactNode, type Ref } from 'react';

type ModalKind = 'Dialog' | 'AlertDialog' | 'Sheet';

interface ModalEntry {
  kind: ModalKind;
  open: boolean;
  order: number;
}

interface ModalRoot {
  id: string;
  busy: boolean;
  open: boolean;
}

const entries = new Map<string, ModalEntry>();
const popups = new Map<string, HTMLElement>();
const reported = new Set<string>();
const sequence = { last: 0 };

const ModalRootContext = createContext<ModalRoot | null>(null);
const ModalBusyContext = createContext(false);

export const ModalRootProvider = ModalRootContext;

export function useModalBusy(): boolean {
  return useContext(ModalBusyContext);
}

export interface ModalBusyProps {
  /** Blocks every user-initiated close while true and disables every Button inside the popup. Pass the in-flight condition, or false for a modal that runs no action. */
  busy: boolean;
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
  const id = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;

  useLayoutEffect(() => {
    sequence.last += 1;
    entries.set(id, { kind, open: isOpen, order: sequence.last });
    if (!isOpen) reported.delete(id);
    return () => {
      entries.delete(id);
    };
  }, [id, kind, isOpen]);

  const guarded = guardOpenChange(busy, onOpenChange);
  const handleOpenChange = (next: boolean, details: D) => {
    guarded(next, details);
    if (open === undefined && !details.isCanceled) setUncontrolledOpen(next);
  };
  const value = useMemo(() => ({ id, busy, open: isOpen }), [id, busy, isOpen]);
  return { value, onOpenChange: handleOpenChange };
}

const labelOf = (id: string, entry: ModalEntry) => {
  const title = popups.get(id)?.querySelector('[data-slot$="-title"]')?.textContent;
  return title ? `${entry.kind} "${title}"` : entry.kind;
};

function attachRef(ref: Ref<HTMLDivElement> | undefined, node: HTMLDivElement | null): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(node);
    return typeof cleanup === 'function' ? cleanup : () => ref(null);
  }
  if (ref) {
    ref.current = node;
    return () => {
      ref.current = null;
    };
  }
  return () => undefined;
}

export function useModalPopup(forwardedRef: Ref<HTMLDivElement> | undefined) {
  const id = useContext(ModalRootContext)?.id;

  return useCallback(
    (node: HTMLDivElement | null) => {
      if (id && node) popups.set(id, node);
      const detach = attachRef(forwardedRef, node);
      return () => {
        if (id) popups.delete(id);
        detach();
      };
    },
    [id, forwardedRef],
  );
}

/** Only one modal may be open at a time. A second one logs instead of throwing. */
export function ModalBusyScope({ children }: Readonly<{ children: ReactNode }>) {
  const root = useContext(ModalRootContext);
  const id = root?.id;
  const open = root?.open;

  useEffect(() => {
    if (!id || !open) return;
    const self = entries.get(id);
    if (!self || reported.has(id)) return;
    for (const [otherId, other] of entries) {
      if (otherId !== id && other.open && other.order < self.order) {
        reported.add(id);
        console.error(`Two modals are open at once: ${labelOf(otherId, other)} and ${labelOf(id, self)}. Open one modal at a time.`);
        return;
      }
    }
  }, [id, open]);

  return <ModalBusyContext value={root?.busy ?? false}>{children}</ModalBusyContext>;
}
