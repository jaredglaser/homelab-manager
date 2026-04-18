import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';

mock.module('@/lib/utils/icon-resolver', () => ({
  AVAILABLE_ICONS: ['nginx', 'redis', 'postgres', 'docker'],
}));

mock.module('@/lib/constants/ui-timing', () => ({
  SELECTION_FEEDBACK_MS: 0,
  DRAWER_ENTER_MS: 0,
  DRAWER_EXIT_MS: 0,
  DRAWER_EASING: 'ease',
}));

const { default: IconPickerDialog } = await import('../IconPickerDialog');

const defaultProps = {
  open: true,
  onClose: () => {},
  onSelect: () => {},
  currentIcon: null,
  containerName: 'my-container',
};

describe('IconPickerDialog', () => {
  it('renders title with containerName when open', () => {
    render(<IconPickerDialog {...defaultProps} />);
    expect(screen.getByText('Select Icon for my-container')).toBeDefined();
  });

  it('renders a search input with placeholder', () => {
    render(<IconPickerDialog {...defaultProps} />);
    expect(screen.getByPlaceholderText('Search icons...')).toBeDefined();
  });

  it('shows "No icons found" when search matches nothing', () => {
    render(<IconPickerDialog {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search icons...');
    fireEvent.change(input, { target: { value: 'does-not-exist-xyz' } });
    expect(screen.getByText(/No icons found/)).toBeDefined();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = mock(() => {});
    render(<IconPickerDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears search state when closed and re-opened', () => {
    const onClose = mock(() => {});
    const { rerender } = render(<IconPickerDialog {...defaultProps} onClose={onClose} />);
    const input = screen.getByPlaceholderText('Search icons...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nginx' } });
    expect(input.value).toBe('nginx');

    fireEvent.click(screen.getByLabelText('Close'));

    rerender(<IconPickerDialog {...defaultProps} onClose={onClose} />);
    const reopenedInput = screen.getByPlaceholderText('Search icons...') as HTMLInputElement;
    expect(reopenedInput.value).toBe('');
  });
});
