import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockModule } from '@/lib/test/mock-module';
import { findOpenTooltip, roleReasonOf, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import type * as Router from '@tanstack/react-router';
import type * as SettingsFunctions from '@/data/settings/functions';

const mockUpdateSetting = mock(() => Promise.resolve());

mockModule<typeof Router>('@tanstack/react-router', (real) => ({
  ...real,
  useLocation: <T,>(opts?: { select?: (location: { hash: string }) => T }) => opts?.select?.({ hash: '' }),
  useNavigate: () => mock(() => Promise.resolve()),
}));

mockModule<typeof SettingsFunctions>('@/data/settings/functions', (real) => ({
  ...real,
  updateSetting: mockUpdateSetting,
}));

void mock.module('@/components/settings/ManagedHostsCardConnected', () => ({ ManagedHostsCard: () => null }));
void mock.module('@/components/settings/AuthManagementCard', () => ({ AuthManagementCard: () => null, GitTokensSection: () => null }));

const { Route } = await import('@/routes/settings');
const SettingsPage = Route.options.component!;

const SAVING_CONTROLS = 15;

function savingControls(): HTMLElement[] {
  return [
    ...screen.getAllByRole('switch'),
    ...screen.getAllByRole('slider').filter((slider) => !slider.closest('[aria-label$=" retention"]')),
    ...screen.getAllByRole('combobox'),
  ];
}

beforeEach(() => {
  mockUpdateSetting.mockClear();
});

describe('Settings page roles', () => {
  it('shows a viewer every control that saves a setting disabled with the role reason, and using them saves nothing', async () => {
    seedSession('viewer');
    render(<SettingsPage />);
    const user = setupUser();
    const controls = savingControls();
    expect(controls).toHaveLength(SAVING_CONTROLS);
    const gates = document.querySelectorAll('[data-slot="role-gate"]');
    expect(gates).toHaveLength(SAVING_CONTROLS);
    for (const control of controls) {
      const gate = control.closest('[data-slot="role-gate"]');
      expect(gate).not.toBeNull();
      expect(roleReasonOf(gate!)).toBe(VIEWER_DENIED_COPY);
      expect(control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true').toBe(true);
      fireEvent.click(control);
    }
    await user.hover(gates[0]);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'] as const)('lets an %s change a setting', async (role) => {
    seedSession(role);
    render(<SettingsPage />);
    expect(savingControls()).toHaveLength(SAVING_CONTROLS);
    expect(document.querySelectorAll('[data-slot="role-gate"]')).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() => expect(mockUpdateSetting).toHaveBeenCalledTimes(1));
  });
});
