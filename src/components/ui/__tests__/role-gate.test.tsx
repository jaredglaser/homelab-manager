import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/test/testing-library';
import { RoleGate } from '@/components/ui/role-gate';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
        {(blocked) => <Switch aria-label="Sparklines" readOnly={blocked} aria-disabled={blocked || undefined} onCheckedChange={onCheckedChange} />}
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
    expect(control.getAttribute('tabindex')).toBe('0');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(roleReasonOf(control)).toBe(copy);
    fireEvent.click(control);
    await setupUser().hover(control);
    expect(await findOpenTooltip()).toBe(copy);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('shows the denied reason it is given in place of the role reason', async () => {
    seedSession('viewer');
    const { control } = renderGatedSwitch('write', 'Your role cannot see this.');
    expect(roleReasonOf(control)).toBe('Your role cannot see this.');
    await setupUser().hover(control);
    expect(await findOpenTooltip()).toBe('Your role cannot see this.');
  });

  it('opens the reason on a touch tap and closes it on a press elsewhere', async () => {
    seedSession('viewer');
    const { control } = renderGatedSwitch('write');
    fireEvent.pointerDown(control, { pointerType: 'touch' });
    fireEvent.pointerUp(control, { pointerType: 'touch' });
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);

    fireEvent.pointerDown(screen.getByText('elsewhere'), { pointerType: 'touch' });
    await waitFor(() => expect(openTooltip()).toBeNull());
  });

  it('keeps the control disabled, with no reason, while the session is still loading', () => {
    clearSession();
    const { control, onCheckedChange } = renderGatedSwitch('write');
    expect(control.getAttribute('aria-describedby')).toBeNull();
    expect(control.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('names the focusable wrapper it puts around a control that cannot take focus while blocked', async () => {
    seedSession('viewer');
    const onValueChange = mock(() => undefined);
    render(
      <RoleGate requires="write" wrapper={{ label: 'Chart Window' }}>
        {(blocked) => <Slider aria-label="Chart Window" value={60} min={60} max={1800} disabled={blocked} onValueChange={onValueChange} />}
      </RoleGate>,
    );
    const group = document.querySelector('[data-slot="role-gate"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Chart Window');
    expect(group.getAttribute('tabindex')).toBe('0');
    expect(roleReasonOf(group)).toBe(VIEWER_DENIED_COPY);
    expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(true);
    await setupUser().hover(group);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('keeps a blocked select trigger from drawing its open ring while the reason tooltip is open', async () => {
    seedSession('viewer');
    render(
      <Select readOnly value="a">
        <RoleGate requires="write">
          {(blocked) => (
            <SelectTrigger aria-label="Memory Display" aria-disabled={blocked || undefined}>
              <SelectValue />
            </SelectTrigger>
          )}
        </RoleGate>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Memory Display' });
    await setupUser().hover(trigger);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(trigger.hasAttribute('data-popup-open')).toBe(true);
    expect(trigger.className).toContain('aria-disabled:data-[popup-open]:ring-0');
    expect(trigger.className).toContain('aria-disabled:data-[popup-open]:border-foreground/25');
  });
});
