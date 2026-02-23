import { useAtomValue } from 'jotai';
import { Snackbar } from '@mui/joy';
import { toastsAtom, useToast } from '@/hooks/toastAtom';

export default function Toasts() {
  const toasts = useAtomValue(toastsAtom);
  const { dismissToast } = useToast();

  if (toasts.length === 0) return null;

  const toast = toasts[0];

  return (
    <Snackbar
      open
      color="danger"
      variant="soft"
      autoHideDuration={4000}
      onClose={() => dismissToast(toast.id)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      {toast.message}
    </Snackbar>
  );
}
