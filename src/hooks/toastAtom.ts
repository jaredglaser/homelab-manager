import { useCallback } from 'react';
import { toast } from 'sonner';

export type ToastSeverity = 'success' | 'info' | 'warning' | 'error';

/**
 * Thin wrapper over sonner for showToast(message, severity). Sonner owns
 * queueing and dismissal.
 */
export function useToast() {
  const showToast = useCallback((message: string, severity: ToastSeverity) => {
    toast[severity](message);
  }, []);

  return { showToast };
}
