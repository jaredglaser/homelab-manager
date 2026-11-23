import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/test/testing-library';
import { RoleGate } from '@/components/ui/role-gate';
import { Switch } from '@/components/ui/switch';
import { OPERATOR_DENIED_COPY, VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import { clearSession, findOpenTooltip, openTooltip, roleReasonOf, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { mockModule } from '@/lib/test/mock-module';
import type * as AuthFunctions from '@/data/auth.functions';

mockModule<typeof AuthFunctions>('@/data/auth.functions', (real) => ({
  ...real,
  getSession: () => new Promise(() => undefined),
}));

function renderGatedSwitch(requires: 'write' | 'admin', deniedReason?: string) {
  const onCheckedChange = mock(() => undefined);
  render(
    <>
      <RoleGate requires={requires} deniedReason={deniedReason}>
        {(blocked) => <Switch aria-label="Sparklines" disabled={blocked} onCheckedChange={onCheckedChange} />}
      </RoleGate>
      <p>elsewhere</p>
    </>,
  );
  return { control: screen.getByRole('switch', { name: 'Sparklines' }), onCheckedChange };
}

describe('RoleGate', () => {
  it.each(['admin', 'operator'] as const)('renders the bare control, enabled, for an %s on a write requirement', (role) => {
    seedSession(role);
    const { control, onCheckedChange } = renderGatedSwitch('write');
    expect(control.closest('[data-slot="role-gate"]')).toBeNull();
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['viewer', 'write', VIEWER_DENIED_COPY],
    ['operator', 'admin', OPERATOR_DENIED_COPY],
  ] as const)('disables the control for a %s on a %s requirement and opens the reason on hover', async (role, requires, copy) => {
    seedSession(role);
    const { control, onCheckedChange } = renderGatedSwitch(requires);
    const gate = control.closest('[data-slot="role-gate"]');
    expect(gate).not.toBeNull();
    expect(roleReasonOf(gate!)).toBe(copy);
    fireEvent.click(control);
    await setupUser().hover(gate!);
    expect(await findOpenTooltip()).toBe(copy);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('shows the denied reason it is given in place of the role reason', async () => {
    seedSession('viewer');
    const { control } = renderGatedSwitch('write', 'Your role cannot see this.');
    const gate = control.closest('[data-slot="role-gate"]')!;
    expect(roleReasonOf(gate)).toBe('Your role cannot see this.');
    await setupUser().hover(gate);
    expect(await findOpenTooltip()).toBe('Your role cannot see this.');
  });

  it('opens the reason on a touch tap and closes it on a press elsewhere', async () => {
    seedSession('viewer');
    const { control } = renderGatedSwitch('write');
    const gate = control.closest('[data-slot="role-gate"]')!;
    fireEvent.pointerDown(gate, { pointerType: 'touch' });
    fireEvent.pointerUp(gate, { pointerType: 'touch' });
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);

    fireEvent.pointerDown(screen.getByText('elsewhere'), { pointerType: 'touch' });
    await waitFor(() => expect(openTooltip()).toBeNull());
  });

  it('keeps the control disabled, with no reason, while the session is still loading', () => {
    clearSession();
    const { control, onCheckedChange } = renderGatedSwitch('write');
    expect(control.closest('[data-slot="role-gate"]')).toBeNull();
    expect(control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
