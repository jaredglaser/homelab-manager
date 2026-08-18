import { describe, it, expect, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import IconTooltip from '@/components/docker/IconTooltip';

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

function renderIconTooltip() {
  render(
    <IconTooltip label="Start">
      <button type="button">Icon</button>
    </IconTooltip>,
  );
  const trigger = screen.getByRole('button', { name: 'Icon' }).parentElement as HTMLElement;
  return { trigger };
}

describe('IconTooltip on a mouse pointer', () => {
  it('shows the tooltip on mouse enter and hides it on mouse leave', () => {
    setTouch(false);
    const { trigger } = renderIconTooltip();

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('Start');
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the tooltip on focus and hides it on blur', () => {
    setTouch(false);
    const { trigger } = renderIconTooltip();

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('Start');
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ignores a click, leaving hover as the only way to reveal it', () => {
    setTouch(false);
    const { trigger } = renderIconTooltip();

    fireEvent.click(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('IconTooltip on a touch pointer', () => {
  it('reveals the tooltip on tap', () => {
    setTouch(true);
    const { trigger } = renderIconTooltip();

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('Start');
  });

  it('dismisses on a second tap of the same trigger', () => {
    setTouch(true);
    const { trigger } = renderIconTooltip();

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses on a tap elsewhere', () => {
    setTouch(true);
    const { trigger } = renderIconTooltip();
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
    const { trigger } = renderIconTooltip();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
