import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';

type DeleteMode = 'unmanage' | 'teardown';

interface DeleteStackDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (teardown: boolean) => void;
  stackName: string;
  isLoading: boolean;
}

export default function DeleteStackDialog({
  open,
  onClose,
  onConfirm,
  stackName,
  isLoading,
}: Readonly<DeleteStackDialogProps>) {
  const [mode, setMode] = useState<DeleteMode | null>(null);

  useEffect(() => {
    if (!open) setMode(null);
  }, [open]);

  function handleClose() {
    setMode(null);
    onClose();
  }

  function handleConfirm() {
    if (mode === null) return;
    onConfirm(mode === 'teardown');
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete {stackName}?</DialogTitle>
      <DialogContent>
        <FormControl component="fieldset" className="w-full">
          <RadioGroup
            value={mode ?? ''}
            onChange={(e) => setMode(e.target.value as DeleteMode)}
          >
            <FormControlLabel
              value="unmanage"
              control={<Radio />}
              label={
                <div className="py-1">
                  <Typography variant="body2" className="font-medium">
                    Remove from management
                  </Typography>
                  <Typography variant="caption" className="opacity-70">
                    Containers keep running. Removes from git repo only.
                  </Typography>
                </div>
              }
            />
            <FormControlLabel
              value="teardown"
              control={<Radio />}
              label={
                <div className="py-1">
                  <Typography
                    variant="body2"
                    className="font-medium text-(--mui-palette-error-main)"
                  >
                    Tear down &amp; remove
                  </Typography>
                  <Typography variant="caption" className="opacity-70">
                    Stops containers, removes from git repo.
                  </Typography>
                </div>
              }
            />
          </RadioGroup>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="inherit" disabled={isLoading}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          color="error"
          disabled={mode === null || isLoading}
        >
          Delete Stack
        </Button>
      </DialogActions>
    </Dialog>
  );
}
