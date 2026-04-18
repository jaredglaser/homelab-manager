import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';

mock.module('@/lib/constants/ui-timing', () => ({
  DRAWER_ENTER_MS: 0,
  DRAWER_EXIT_MS: 0,
  DRAWER_EASING: 'ease',
}));

const { default: BottomDrawer } = await import('../BottomDrawer');

describe('BottomDrawer', () => {
  it('renders children when open', () => {
    render(
      <BottomDrawer open={true} onClose={() => {}}>
        <div data-testid="drawer-content">Hello</div>
      </BottomDrawer>,
    );
    expect(screen.getByTestId('drawer-content')).toBeDefined();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = mock(() => {});
    render(
      <BottomDrawer open={true} onClose={onClose}>
        <div>Content</div>
      </BottomDrawer>,
    );
    const backdrop = document.querySelector('.MuiBackdrop-root');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops propagation of backdrop clicks so parent handlers do not fire', () => {
    const parentClick = mock(() => {});
    render(
      <div onClick={parentClick}>
        <BottomDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </BottomDrawer>
      </div>,
    );
    const backdrop = document.querySelector('.MuiBackdrop-root');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
