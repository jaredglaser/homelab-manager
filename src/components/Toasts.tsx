import { Toaster } from 'sonner';

/* Matches the previous MUI Snackbar placement and 4s auto-dismiss. */
export default function Toasts() {
  return (
    <Toaster
      position="bottom-center"
      duration={4000}
      closeButton
      toastOptions={{
        classNames: {
          toast: 'bg-card! text-card-foreground! border-border!',
          success: 'text-success!',
          error: 'text-destructive!',
          warning: 'text-warning!',
          info: 'text-info!',
        },
      }}
    />
  );
}
