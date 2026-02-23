import { atom, useSetAtom } from 'jotai';
import { useCallback } from 'react';

export interface Toast {
  id: number;
  message: string;
}

let nextId = 0;

export const toastsAtom = atom<Toast[]>([]);

export function useToast() {
  const setToasts = useSetAtom(toastsAtom);

  const showToast = useCallback(
    (message: string) => {
      const id = nextId++;
      setToasts(prev => [...prev, { id, message }]);
    },
    [setToasts]
  );

  const dismissToast = useCallback(
    (id: number) => {
      setToasts(prev => prev.filter(t => t.id !== id));
    },
    [setToasts]
  );

  return { showToast, dismissToast };
}
