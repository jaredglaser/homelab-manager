import { describe, expect, it, spyOn } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { setupUser } from '@/lib/test/user-event';
import IconTooltip from '../IconTooltip';

function renderTooltip() {
  render(
    <IconTooltip label="Restart container">
      <button type="button">restart</button>
    </IconTooltip>,
  );
  const trigger = screen.getByRole('button', { name: 'restart' });
  spyOn(trigger.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 40,
    width: 24,
    height: 24,
  } as DOMRect);
  return trigger;
}

describe('IconTooltip', () => {
  it('shows the label centered above the trigger on hover and hides it on leave', async () => {
    const user = setupUser();
    const trigger = renderTooltip();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.hover(trigger);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe('Restart container');
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip.style.left).toBe('112px');
    expect(tooltip.style.top).toBe('40px');

    await user.unhover(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the label while the trigger has keyboard focus', async () => {
    const user = setupUser();
    renderTooltip();

    await user.tab();
    expect(screen.getByRole('tooltip').textContent).toBe('Restart container');

    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
