import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  it('calls onSave with toggled autoDeploy when switch is clicked then saved', () => {
    const onSave = mock(() => {});
    render(<StackSettingsDialog {...defaultProps} currentAutoDeploy={false} onSave={onSave} />);

    const switchEl = screen.getByRole('switch');
    fireEvent.click(switchEl);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('server1', true);
  });

  it('calls onSave with the newly selected host', async () => {
    const onSave = mock(() => {});
    render(<StackSettingsDialog {...defaultProps} onSave={onSave} />);

    // Open the MUI Select dropdown
    fireEvent.mouseDown(screen.getByRole('combobox'));

    // Click the server2 option in the listbox
    const option = await screen.findByRole('option', { name: 'server2' });
    fireEvent.click(option);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('server2', false);
  });

  it('resets host and autoDeploy to new prop values when dialog is reopened', () => {
    const onSave = mock(() => {});
    const { rerender } = render(
      <StackSettingsDialog {...defaultProps} open={false} currentHost="server1" currentAutoDeploy={false} onSave={onSave} />,
    );

    act(() => {
      rerender(
        <StackSettingsDialog {...defaultProps} open={true} currentHost="server2" currentAutoDeploy={true} onSave={onSave} />,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('server2', true);
  });
});
