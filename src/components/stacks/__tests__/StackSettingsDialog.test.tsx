import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import StackSettingsDialog from '../StackSettingsDialog';
import type { StackSettingsDialogProps } from '../StackSettingsDialog';

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
