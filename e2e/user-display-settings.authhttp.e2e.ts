import { expect, test, type Page } from '@playwright/test';
import { emailOf } from './auth/login';
import { loginInNewContext } from './auth/session-contract';
import { clearUserSettings, userSettingValue } from './auth/session-db';

const BASE = 'http://localhost:3201';
const KEY = 'general/useAbbreviatedUnits';

// The switch shows the code default until the init frame lands, so a read before it proves nothing.
function userSettingsInit(page: Page): Promise<void> {
  return new Promise((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string' && payload.includes('"topic":"user-settings"') && payload.includes('"kind":"data"')) {
          resolve();
        }
      });
    });
  });
}

async function openSettings(page: Page) {
  const init = userSettingsInit(page);
  await page.goto(`${BASE}/settings`);
  await init;
  return page.getByRole('switch', { name: 'Use Abbreviated Units' });
}

test("a viewer's display setting reaches their other tab live, survives a reload and leaves the admin's value alone", async ({
  browser,
}) => {
  const admin = await loginInNewContext(browser, BASE, 'admin');
  const viewer = await loginInNewContext(browser, BASE, 'viewer');
  try {
    await clearUserSettings(emailOf('admin'));
    await clearUserSettings(emailOf('viewer'));

    const adminSwitch = await openSettings(admin.page);
    await expect(adminSwitch).toHaveAttribute('aria-checked', 'false');
    const viewerOtherTab = await viewer.context.newPage();
    const viewerOtherSwitch = await openSettings(viewerOtherTab);

    const viewerSwitch = await openSettings(viewer.page);
    await expect(viewerSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(viewerSwitch).not.toHaveAttribute('aria-disabled', 'true');
    await viewerSwitch.click();
    await expect(viewerSwitch).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => userSettingValue(emailOf('viewer'), KEY)).toBe('true');
    await expect(viewer.page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

    // The viewer's other tab getting the change proves the broadcast went out before the admin is checked.
    await expect(viewerOtherSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(adminSwitch).toHaveAttribute('aria-checked', 'false');
    expect(await userSettingValue(emailOf('admin'), KEY)).toBeNull();

    const reloaded = userSettingsInit(viewer.page);
    await viewer.page.reload();
    await reloaded;
    await expect(viewerSwitch).toHaveAttribute('aria-checked', 'true');
  } finally {
    await clearUserSettings(emailOf('admin'));
    await clearUserSettings(emailOf('viewer'));
    await admin.context.close();
    await viewer.context.close();
  }
});
