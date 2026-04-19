import type { AlertColor } from '@mui/material';
import { atom, useSetAtom } from 'jotai';
import { useCallback } from 'react';

export interface Toast {
  id: number;
  message: string;
  severity: AlertColor;
}

let nextId = 0;

export const toastsAtom = atom<Toast[]>([]);

export function useToast() {
  const setToasts = useSetAtom(toastsAtom);

  const showToast = useCallback(
    (message: string, severity: AlertColor = 'error') => {
      const id = nextId++;
      setToasts(prev => [...prev, { id, message, severity }]);
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
