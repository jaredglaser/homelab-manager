import { useCallback } from 'react';
import { toast } from 'sonner';

export type ToastSeverity = 'success' | 'info' | 'warning' | 'error';

/**
 * Thin wrapper over sonner that preserves the showToast(message, severity)
 * call-site API from the Snackbar era. Sonner owns queueing and dismissal.
 */
export function useToast() {
  const showToast = useCallback((message: string, severity: ToastSeverity) => {
    toast[severity](message);
  }, []);

  return { showToast };
}
