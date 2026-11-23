import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/test/testing-library';
import { Provider, createStore } from 'jotai';
import { mockModule } from '@/lib/test/mock-module';
import { roleReasonOf, seedSession } from '@/lib/test/session';
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


function renderPage() {
  render(<Provider store={createStore()}><SettingsPage /></Provider>);
}

beforeEach(() => {
  mockUpdateSetting.mockClear();
});

describe('Settings page roles', () => {
  it('shows a viewer every control that saves a setting disabled with the role reason, and using them saves nothing', async () => {
    seedSession('viewer');
    renderPage();
    const user = setupUser();
    const switches = screen.getAllByRole('switch');
    const comboboxes = screen.getAllByRole('combobox');
    const sliders = screen.getAllByRole('slider').filter((slider) => !slider.closest('[aria-label$=" retention"]'));
    expect(switches.length + comboboxes.length + sliders.length).toBe(SAVING_CONTROLS);

    // A switch and a select trigger stay focusable while blocked, so each carries its own name, state and reason.
    for (const control of [...switches, ...comboboxes]) {
      expect(control.getAttribute('aria-label')).toBeTruthy();
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(roleReasonOf(control)).toBe(VIEWER_DENIED_COPY);
    }
    for (const control of switches) fireEvent.click(control);
    expect(screen.getByRole('switch', { name: 'Show Sparklines' }).getAttribute('aria-checked')).toBe('true');

    // A slider thumb cannot take focus while disabled, so a named group stands in for it.
    for (const slider of sliders) {
      const group = slider.closest('[data-slot="role-gate"]');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe(slider.closest('[data-slot="slider"]')?.getAttribute('aria-label'));
      expect(roleReasonOf(group!)).toBe(VIEWER_DENIED_COPY);
      expect(slider.hasAttribute('disabled')).toBe(true);
    }

    // A read-only select still opens to show the options, as Base UI intends, but picking one commits nothing.
    await user.click(screen.getByRole('combobox', { name: 'Memory Display' }));
    await user.click(await screen.findByRole('option', { name: 'Percentage (%)' }));
    expect(mockUpdateSetting).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Memory Display' }).textContent).toBe('bytes');
  });

  it.each(['admin', 'operator'] as const)('lets an %s change a switch, a slider and a select', async (role) => {
    seedSession(role);
    renderPage();
    const user = setupUser();
    expect(document.querySelectorAll('[data-slot="role-gate"], [aria-disabled="true"]')).toHaveLength(0);

    fireEvent.click(screen.getByRole('switch', { name: 'Show Sparklines' }));
    await waitFor(() => expect(mockUpdateSetting).toHaveBeenLastCalledWith({ data: { key: 'general/showSparklines', value: 'false' } }));

    fireEvent.keyDown(screen.getAllByRole('slider')[0], { key: 'End' });
    await waitFor(() => expect(mockUpdateSetting).toHaveBeenLastCalledWith({ data: { key: 'general/updateIntervalMs', value: '60000' } }));

    await user.click(screen.getByRole('combobox', { name: 'Memory Display' }));
    await user.click(await screen.findByRole('option', { name: 'Percentage (%)' }));
    await waitFor(() => expect(mockUpdateSetting).toHaveBeenLastCalledWith({ data: { key: 'docker/memoryDisplayMode', value: 'percentage' } }));
  });
});
