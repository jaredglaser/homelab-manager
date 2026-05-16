import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, act } from '@testing-library/react';

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

let origGetBCR: typeof HTMLElement.prototype.getBoundingClientRect;
const origDescriptors = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};

beforeEach(() => {
  origGetBCR = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 800, height: 600, top: 0, right: 800, bottom: 600, left: 0, toJSON: () => '' };
  };
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 600; } });
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = origGetBCR;
  for (const prop of ['clientHeight', 'scrollHeight', 'offsetHeight'] as const) {
    const desc = origDescriptors[prop];
    if (desc) {
      Object.defineProperty(HTMLElement.prototype, prop, desc);
    } else {
      // Descriptor didn't exist originally: delete the test-installed getter so it doesn't leak to other tests.
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
});

describe('IconPickerDialog', () => {
  it('renders title with containerName when open', () => {
    render(<IconPickerDialog {...defaultProps} />);
    expect(screen.getByText('Select Icon for my-container')).toBeDefined();
  });

  it('renders a search input', () => {
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

  it('filters the icon list when searching', () => {
    render(<IconPickerDialog {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search icons...');
    fireEvent.change(input, { target: { value: 'nginx' } });
    expect(screen.getByAltText('nginx')).toBeDefined();
    expect(screen.queryByAltText('redis')).toBeNull();
  });

  it('calls onSelect and closes after selecting an icon and clicking Apply', async () => {
    const onSelect = mock((_slug: string | null) => {});
    const onClose = mock(() => {});
    render(<IconPickerDialog {...defaultProps} onSelect={onSelect} onClose={onClose} />);

    // Select an icon tile (sets pending selection)
    const img = screen.getByAltText('nginx');
    const btn = img.closest('button');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);

    // onSelect not yet called — need to confirm via Apply
    expect(onSelect).not.toHaveBeenCalled();

    // Click Apply to commit the selection
    fireEvent.click(screen.getByText('Apply'));
    expect(onSelect).toHaveBeenCalledWith('nginx');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect(null) and closes when "Use auto-detected" is clicked', async () => {
    const onSelect = mock((_slug: string | null) => {});
    const onClose = mock(() => {});
    render(<IconPickerDialog {...defaultProps} onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByText('Use auto-detected'));
    expect(onSelect).toHaveBeenCalledWith(null);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
