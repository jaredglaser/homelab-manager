import { describe, it, expect, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import TapTooltip from '@/components/ui/tap-tooltip';

const originalMatchMedia = window.matchMedia;

function setTouch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

function renderTapTooltip() {
  render(
    <TapTooltip content="Disk name: nvme0n1">
      <button type="button">chip</button>
    </TapTooltip>,
  );
  const trigger = screen.getByRole('button', { name: 'chip' }).parentElement as HTMLElement;
  return { trigger };
}

describe('TapTooltip on a mouse pointer', () => {
  it('shows on mouse enter and hides on mouse leave', () => {
    setTouch(false);
    const { trigger } = renderTapTooltip();

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('Disk name: nvme0n1');
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows on focus and hides on blur', () => {
    setTouch(false);
    const { trigger } = renderTapTooltip();

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).not.toBeNull();
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ignores a click, leaving hover as the only way to reveal it', () => {
    setTouch(false);
    const { trigger } = renderTapTooltip();

    fireEvent.click(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('TapTooltip on a touch pointer', () => {
  it('reveals the content on tap', () => {
    setTouch(true);
    const { trigger } = renderTapTooltip();

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('Disk name: nvme0n1');
  });

  it('dismisses on a second tap of the same trigger', () => {
    setTouch(true);
    const { trigger } = renderTapTooltip();

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses on a tap elsewhere', () => {
    setTouch(true);
    const { trigger } = renderTapTooltip();
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).not.toBeNull();
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole('tooltip')).toBeNull();

    outside.remove();
  });

  it('ignores hover and focus, which a touch device can never satisfy', () => {
    setTouch(true);
    const { trigger } = renderTapTooltip();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('supports rich ReactNode content, not just strings', () => {
    setTouch(true);
    render(
      <TapTooltip content={<span data-testid="rich">rich content</span>}>
        <button type="button">chip</button>
      </TapTooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'chip' }).parentElement as HTMLElement;

    fireEvent.click(trigger);
    expect(screen.getByTestId('rich')).not.toBeNull();
  });
});
