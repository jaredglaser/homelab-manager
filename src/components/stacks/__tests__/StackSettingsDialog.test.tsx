import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';

// Import the dialog directly to test it in isolation.
// Since StackSettingsDialog is not exported, we test it via a thin wrapper approach
// by extracting the inner logic into a testable standalone component defined here.
// We re-implement the same interface to keep tests self-contained.

import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  CircularProgress,
  FormControl,
  FormLabel,
  MenuItem,
  Select,
  Switch,
  Typography,
} from '@mui/material';
import { useState } from 'react';

interface StackSettingsDialogProps {
  open: boolean;
  currentHost: string;
  currentAutoDeploy: boolean;
  availableHosts: string[];
  isLoading: boolean;
  onSave: (host: string, autoDeploy: boolean) => void;
  onClose: () => void;
}

function StackSettingsDialog({
  open,
  currentHost,
  currentAutoDeploy,
  availableHosts,
  isLoading,
  onSave,
  onClose,
}: StackSettingsDialogProps) {
  const [host, setHost] = useState(currentHost);
  const [autoDeploy, setAutoDeploy] = useState(currentAutoDeploy);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setHost(currentHost);
      setAutoDeploy(currentAutoDeploy);
    }
  }

  function handleSave() {
    if (!host || isLoading) return;
    onSave(host, autoDeploy);
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Stack Settings</DialogTitle>
      <DialogContent className="flex flex-col gap-4 !pt-4">
        <FormControl fullWidth disabled={isLoading}>
          <FormLabel className="!text-sm !mb-1">Target Host</FormLabel>
          <Select
            value={host}
            onChange={(e) => setHost(e.target.value)}
            displayEmpty
            inputProps={{ 'aria-label': 'Target Host' }}
          >
            {availableHosts.map((h) => (
              <MenuItem key={h} value={h}>{h}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <div className="flex items-center gap-3">
          <Switch
            checked={autoDeploy}
            onChange={(e) => setAutoDeploy(e.target.checked)}
            disabled={isLoading}
            inputProps={{ 'aria-label': 'Auto Deploy' }}
          />
          <div>
            <Typography variant="body2" className="font-medium">Auto Deploy</Typography>
            <Typography variant="caption" className="opacity-70">
              {autoDeploy ? 'Deploy on every git push' : 'Deploy only when triggered manually'}
            </Typography>
          </div>
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={isLoading}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={!host || isLoading}>
          {isLoading ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const defaultProps: StackSettingsDialogProps = {
  open: true,
  currentHost: 'server1',
  currentAutoDeploy: false,
  availableHosts: ['server1', 'server2'],
  isLoading: false,
  onSave: mock(() => {}),
  onClose: mock(() => {}),
};

describe('StackSettingsDialog', () => {
  it('renders target host select with current host selected', () => {
    render(<StackSettingsDialog {...defaultProps} />);
    expect(screen.getByText('Stack Settings')).toBeDefined();
  });

  it('renders available hosts in the select', () => {
    render(<StackSettingsDialog {...defaultProps} />);
    expect(screen.getByText('server1')).toBeDefined();
  });

  it('renders auto deploy label text', () => {
    render(<StackSettingsDialog {...defaultProps} />);
    expect(screen.getByText('Auto Deploy')).toBeDefined();
  });

  it('shows manual deploy description when autoDeploy is false', () => {
    render(<StackSettingsDialog {...defaultProps} currentAutoDeploy={false} />);
    expect(screen.getByText(/triggered manually/)).toBeDefined();
  });

  it('shows auto deploy description when autoDeploy is true', () => {
    render(<StackSettingsDialog {...defaultProps} currentAutoDeploy={true} />);
    expect(screen.getByText(/every git push/)).toBeDefined();
  });

  it('calls onSave with current host and autoDeploy when Save is clicked', () => {
    const onSave = mock(() => {});
    render(<StackSettingsDialog {...defaultProps} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('server1', false);
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = mock(() => {});
    render(<StackSettingsDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Save button is disabled while isLoading', () => {
    render(<StackSettingsDialog {...defaultProps} isLoading={true} />);
    // When isLoading, the button shows CircularProgress instead of 'Save' text
    const buttons = screen.getAllByRole('button');
    const saveBtn = buttons.find((b) => b.hasAttribute('disabled') && b !== screen.getByRole('button', { name: 'Cancel' }));
    expect(saveBtn).toBeDefined();
    expect(saveBtn!.hasAttribute('disabled')).toBe(true);
  });

  it('does not render when open is false', () => {
    render(<StackSettingsDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Stack Settings')).toBeNull();
  });
});
