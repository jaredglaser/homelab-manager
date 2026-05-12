import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

interface RollbackDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  stackName: string;
  commitSha: string;
}

export default function RollbackDialog({
  open,
  onClose,
  onConfirm,
  stackName,
  commitSha,
}: RollbackDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Rollback {stackName}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          This will redeploy commit{' '}
          <code className="font-mono text-xs bg-(--mui-palette-action-hover) px-1 py-0.5 rounded">
            {commitSha}
          </code>
          . Containers will be recreated with the previous compose configuration.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          variant="contained"
          className="bg-red-600! hover:bg-red-700! text-white!"
        >
          Confirm Rollback
        </Button>
      </DialogActions>
    </Dialog>
  );
}
