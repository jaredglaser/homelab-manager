import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@/lib/test/testing-library';
import { Provider, createStore } from 'jotai';
import { mockModule } from '@/lib/test/mock-module';
import { roleReasonOf, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import type * as Router from '@tanstack/react-router';
import type * as SettingsFunctions from '@/data/settings/functions';
import type * as Sonner from 'sonner';

const mockUpdateSetting = mock(() => Promise.resolve());
const mockUpdateUserSetting = mock(() => Promise.resolve());
const mockToastError = mock(() => 0);

mockModule<typeof Router>('@tanstack/react-router', (real) => ({
  ...real,
  useLocation: <T,>(opts?: { select?: (location: { hash: string }) => T }) => opts?.select?.({ hash: '' }),
  useNavigate: () => mock(() => Promise.resolve()),
}));

mockModule<typeof SettingsFunctions>('@/data/settings/functions', (real) => ({
  ...real,
  updateSetting: mockUpdateSetting,
  updateUserSetting: mockUpdateUserSetting,
}));

mockModule<typeof Sonner>('sonner', (real) => ({
  ...real,
  toast: { ...real.toast, error: mockToastError },
}));

void mock.module('@/components/settings/ManagedHostsCardConnected', () => ({ ManagedHostsCard: () => null }));
void mock.module('@/components/settings/AuthManagementCard', () => ({ AuthManagementCard: () => null, GitTokensSection: () => null }));

const { Route } = await import('@/routes/settings');
const SettingsPage = Route.options.component!;

const PREFERENCE_CONTROLS = 12;
const SERVER_CONTROLS = 3;

function renderPage() {
  render(<Provider store={createStore()}><SettingsPage /></Provider>);
}

function sectionControls(heading: string): HTMLElement[] {
  const section = screen.getByRole('region', { name: heading });
  return [
    ...within(section).queryAllByRole('switch'),
    ...within(section).queryAllByRole('combobox'),
    ...within(section).queryAllByRole('slider').filter((slider) => !slider.closest('[aria-label$=" retention"]')),
  ];
}

function sliderNamed(name: string): HTMLElement {
  const slider = screen.getAllByRole('slider').find((s) => s.closest('[data-slot="slider"]')?.getAttribute('aria-label') === name);
  if (!slider) throw new Error(`no slider named ${name}`);
  return slider;
}

beforeEach(() => {
  mockUpdateSetting.mockClear();
  mockUpdateUserSetting.mockClear();
  mockUpdateUserSetting.mockImplementation(() => Promise.resolve());
  mockToastError.mockClear();
});

describe('Settings page roles', () => {
  it.each(['viewer', 'operator', 'admin', 'auth-disabled'] as const)(
    'lets %s change every display preference, saved to their own settings with no role reason and no error',
    async (role) => {
      seedSession(role);
      renderPage();
      const user = setupUser();
      const preferences = sectionControls('Your preferences');
      expect(preferences).toHaveLength(PREFERENCE_CONTROLS);
      for (const control of preferences) {
        expect(control.getAttribute('aria-disabled')).toBeNull();
        expect(control.hasAttribute('disabled')).toBe(false);
        expect(control.closest('[data-slot="role-gate"]')).toBeNull();
        expect(roleReasonOf(control)).toBeNull();
      }

      fireEvent.click(screen.getByRole('switch', { name: 'Show Sparklines' }));
      await waitFor(() => expect(mockUpdateUserSetting).toHaveBeenLastCalledWith({ data: { key: 'general/showSparklines', value: 'false' } }));
      expect(screen.getByRole('switch', { name: 'Show Sparklines' }).getAttribute('aria-checked')).toBe('false');

      fireEvent.click(screen.getByRole('switch', { name: 'Stream Debug Logging' }));
      await waitFor(() => expect(mockUpdateUserSetting).toHaveBeenLastCalledWith({ data: { key: 'developer/sseDebugLogging', value: 'true' } }));

      fireEvent.keyDown(sliderNamed('Chart Window'), { key: 'End' });
      await waitFor(() => expect(mockUpdateUserSetting).toHaveBeenLastCalledWith({ data: { key: 'docker/chartWindowSeconds', value: '1800' } }));

      await user.click(screen.getByRole('combobox', { name: 'Memory Display' }));
      await user.click(await screen.findByRole('option', { name: 'Percentage (%)' }));
      await waitFor(() => expect(mockUpdateUserSetting).toHaveBeenLastCalledWith({ data: { key: 'docker/memoryDisplayMode', value: 'percentage' } }));

      await Promise.all(mockUpdateUserSetting.mock.results.map((r) => r.value));
      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockUpdateSetting).not.toHaveBeenCalled();
    },
  );

  it('shows a viewer every shared server setting disabled with the role reason, and using them saves nothing', () => {
    seedSession('viewer');
    renderPage();
    const server = sectionControls('Server settings');
    expect(server).toHaveLength(SERVER_CONTROLS);

    const switches = server.filter((control) => control.getAttribute('role') === 'switch');
    for (const control of switches) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(roleReasonOf(control)).toBe(VIEWER_DENIED_COPY);
      fireEvent.click(control);
    }

    // A slider thumb cannot take focus while disabled, so a named group stands in for it.
    const slider = sliderNamed('Update Interval');
    const group = slider.closest('[data-slot="role-gate"]');
    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('aria-label')).toBe('Update Interval');
    expect(roleReasonOf(group!)).toBe(VIEWER_DENIED_COPY);
    expect(slider.hasAttribute('disabled')).toBe(true);

    expect(mockUpdateSetting).not.toHaveBeenCalled();
    expect(mockUpdateUserSetting).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'] as const)('lets an %s change the shared server settings', async (role) => {
    seedSession(role);
    renderPage();
    expect(document.querySelectorAll('[data-slot="role-gate"], [aria-disabled="true"]')).toHaveLength(0);

    fireEvent.keyDown(sliderNamed('Update Interval'), { key: 'End' });
    await waitFor(() => expect(mockUpdateSetting).toHaveBeenLastCalledWith({ data: { key: 'general/updateIntervalMs', value: '60000' } }));

    fireEvent.click(screen.getByRole('switch', { name: 'Docker Debug Logging' }));
    await waitFor(() => expect(mockUpdateSetting).toHaveBeenLastCalledWith({ data: { key: 'developer/dockerDebugLogging', value: 'true' } }));
    expect(mockUpdateUserSetting).not.toHaveBeenCalled();
  });
});
