import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupUser } from '@/lib/test/user-event';
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

  it('disables the mode radios and Delete Stack while the delete is in flight, after a mode was selected', () => {
    const view = render(<DeleteStackDialog {...defaultProps} />);
    fireEvent.click(screen.getByDisplayValue('teardown'));
    expect(screen.getByRole('button', { name: 'Delete Stack' }).hasAttribute('disabled')).toBe(false);
    for (const radio of screen.getAllByRole('radio')) expect(radio.hasAttribute('data-disabled')).toBe(false);

    view.rerender(<DeleteStackDialog {...defaultProps} isLoading={true} />);

    expect(screen.getByRole('button', { name: 'Delete Stack' }).hasAttribute('disabled')).toBe(true);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio.hasAttribute('data-disabled')).toBe(true);
  });

  it('does not render when open is false', () => {
    render(<DeleteStackDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Delete my-stack?')).toBeNull();
  });

  it('stays open on Escape while the delete is in flight', async () => {
    const user = setupUser();
    const onClose = mock(() => undefined);
    render(<DeleteStackDialog {...defaultProps} isLoading={true} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete Stack' }).hasAttribute('disabled')).toBe(true);
  });
});
