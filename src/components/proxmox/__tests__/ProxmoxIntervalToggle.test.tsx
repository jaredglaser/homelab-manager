import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntervalToggle } from '@/components/proxmox/ProxmoxIntervalToggle';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import { findOpenTooltip, roleReasonOf, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { mockModule } from '@/lib/test/mock-module';
import type * as AuthFunctions from '@/data/auth.functions';

mockModule<typeof AuthFunctions>('@/data/auth.functions', (real) => ({
  ...real,
  getSession: () => new Promise(() => undefined),
}));

function renderToggle() {
  const onIntervalChange = mock(() => undefined);
  render(<IntervalToggle interval={10000} onIntervalChange={onIntervalChange} />);
  return { onIntervalChange, fast: screen.getByRole('button', { name: '1 second (fast)' }) };
}

describe('IntervalToggle', () => {
  it('is disabled for a viewer and gives the viewer reason on hover', async () => {
    seedSession('viewer');
    const { onIntervalChange, fast } = renderToggle();
    const group = document.querySelector('[data-slot="role-gate"]')!;

    expect(group.getAttribute('aria-label')).toBe('Update interval');
    expect(roleReasonOf(group)).toBe(VIEWER_DENIED_COPY);
    expect(fast.hasAttribute('disabled') || fast.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(fast);
    await setupUser().hover(group);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(onIntervalChange).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'] as const)('lets an %s change the interval', async (role) => {
    seedSession(role);
    const { onIntervalChange, fast } = renderToggle();
    expect(document.querySelector('[data-slot="role-gate"]')).toBeNull();
    await setupUser().click(fast);
    expect(onIntervalChange).toHaveBeenCalledWith(1000);
  });
});
