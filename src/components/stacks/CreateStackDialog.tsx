import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
  Typography,
} from '@mui/material';

const STACK_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

interface CreateStackInput {
  stackName: string;
  host: string;
  autoDeploy: boolean;
}

interface CreateStackDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateStackInput) => void;
  hosts: string[];
  isLoading: boolean;
  error?: string | null;
}

export default function CreateStackDialog({
  open,
  onClose,
  onSubmit,
  hosts,
  isLoading,
  error,
}: CreateStackDialogProps) {
  const [stackName, setStackName] = useState('');
  const [host, setHost] = useState(hosts[0] ?? '');
  const [autoDeploy, setAutoDeploy] = useState(false);

  useEffect(() => {
    if (open) {
      setStackName('');
      setHost(hosts[0] ?? '');
      setAutoDeploy(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile host selection when the available hosts list changes (e.g., background refresh)
  useEffect(() => {
    if (!open) return;
    if (hosts.length === 0) {
      setHost('');
    } else {
      setHost((current) => hosts.includes(current) ? current : hosts[0]);
    }
  }, [open, hosts]);

  const nameError =
    stackName.length > 0 && !STACK_NAME_REGEX.test(stackName)
      ? 'Must start with a letter and contain only letters, numbers, hyphens, and underscores.'
      : '';
  const isValid = stackName.length > 0 && STACK_NAME_REGEX.test(stackName) && host.length > 0;

  function handleClose() {
    setStackName('');
    setHost(hosts[0] ?? '');
    setAutoDeploy(false);
    onClose();
  }

  function handleSubmit() {
    if (!isValid || isLoading) return;
    onSubmit({ stackName, host, autoDeploy });
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create Stack</DialogTitle>
      <DialogContent className="flex flex-col gap-4 pt-4!">
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Stack Name"
          value={stackName}
          onChange={(e) => setStackName(e.target.value)}
          error={!!nameError}
          helperText={nameError || 'e.g. my-app or my_stack'}
          fullWidth
          autoFocus
          disabled={isLoading}
        />
        {hosts.length > 1 && (
          <FormControl fullWidth disabled={isLoading}>
            <FormLabel className="text-sm! mb-1!">Target Host</FormLabel>
            <Select
              value={host}
              onChange={(e) => setHost(e.target.value)}
              displayEmpty
            >
              {hosts.map((h) => (
                <MenuItem key={h} value={h}>
                  {h}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        <FormControl disabled={isLoading}>
          <FormLabel className="text-sm! mb-1!">Deploy Mode</FormLabel>
          <RadioGroup
            value={autoDeploy ? 'auto' : 'manual'}
            onChange={(e) => setAutoDeploy(e.target.value === 'auto')}
          >
            <FormControlLabel
              value="auto"
              control={<Radio />}
              label={
                <span>
                  <Typography variant="body2" component="span" className="font-medium">
                    Auto
                  </Typography>
                  <Typography variant="caption" component="span" className="ml-2 opacity-70">
                    Deploy on every git push
                  </Typography>
                </span>
              }
            />
            <FormControlLabel
              value="manual"
              control={<Radio />}
              label={
                <span>
                  <Typography variant="body2" component="span" className="font-medium">
                    Manual
                  </Typography>
                  <Typography variant="caption" component="span" className="ml-2 opacity-70">
                    Deploy only when triggered manually
                  </Typography>
                </span>
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
          onClick={handleSubmit}
          variant="contained"
          disabled={!isValid || isLoading}
        >
          Create Stack
        </Button>
      </DialogActions>
    </Dialog>
  );
}
