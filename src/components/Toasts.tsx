import { useAtomValue } from 'jotai';
import { Snackbar, Alert } from '@mui/material';
import { toastsAtom, useToast } from '@/hooks/toastAtom';

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
