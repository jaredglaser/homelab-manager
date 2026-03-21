import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import DeleteStackDialog from '../DeleteStackDialog';

const defaultProps = {
  open: true,
  onClose: mock(() => {}),
  onConfirm: mock(() => {}),
  stackName: 'my-stack',
  isLoading: false,
};

describe('DeleteStackDialog', () => {
  it('renders stack name in title', () => {
    render(<DeleteStackDialog {...defaultProps} />);
    expect(screen.getByText('Delete my-stack?')).toBeDefined();
  });

  it('shows two radio options', () => {
    render(<DeleteStackDialog {...defaultProps} />);
    expect(screen.getByText('Remove from management')).toBeDefined();
    expect(screen.getByText('Tear down & remove')).toBeDefined();
  });

  it('Delete Stack button is disabled when no option is selected', () => {
    render(<DeleteStackDialog {...defaultProps} />);
    const btn = screen.getByRole('button', { name: 'Delete Stack' });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('Delete Stack button is enabled after selecting an option', () => {
    render(<DeleteStackDialog {...defaultProps} />);
    const radio = screen.getByDisplayValue('unmanage');
    fireEvent.click(radio);
    const btn = screen.getByRole('button', { name: 'Delete Stack' });
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = mock(() => {});
    render(<DeleteStackDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm with teardown=false when "Remove from management" is selected', () => {
    const onConfirm = mock(() => {});
    render(<DeleteStackDialog {...defaultProps} onConfirm={onConfirm} />);
    const radio = screen.getByDisplayValue('unmanage');
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stack' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('calls onConfirm with teardown=true when "Tear down & remove" is selected', () => {
    const onConfirm = mock(() => {});
    render(<DeleteStackDialog {...defaultProps} onConfirm={onConfirm} />);
    const radio = screen.getByDisplayValue('teardown');
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Stack' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('Delete Stack button is disabled while isLoading', () => {
    render(<DeleteStackDialog {...defaultProps} isLoading={true} />);
    const radio = screen.getByDisplayValue('unmanage');
    fireEvent.click(radio);
    const btn = screen.getByRole('button', { name: 'Delete Stack' });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('does not render when open is false', () => {
    render(<DeleteStackDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Delete my-stack?')).toBeNull();
  });
});
