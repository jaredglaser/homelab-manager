import { useAtomValue } from 'jotai';
import { Snackbar, Alert } from '@mui/material';
import { toastsAtom, useToast } from '@/hooks/toastAtom';

/**
 * Renders the first toast as an error Alert inside a bottom-center Snackbar.
 *
 * Displays only the first entry from the toasts atom; the snackbar auto-hides after 4000ms
 * and dismisses the toast when closed (either automatically or via the Alert close button).
 *
 * @returns A Snackbar containing an Alert with the toast message, or `null` if there are no toasts.
 */
export default function Toasts() {
  const toasts = useAtomValue(toastsAtom);
  const { dismissToast } = useToast();

  if (toasts.length === 0) return null;

  const toast = toasts[0];

  return (
    <Snackbar
      open
      autoHideDuration={4000}
      onClose={() => dismissToast(toast.id)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity="error" onClose={() => dismissToast(toast.id)}>
        {toast.message}
      </Alert>
    </Snackbar>
  );
}
