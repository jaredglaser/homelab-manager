import { expect, test } from '@playwright/test';
import { loginInNewContext } from './auth/session-contract';

const BASE = 'http://localhost:3201';

test('the real server refuses a viewer an admin-only server function that an admin can call', async ({
  browser,
}) => {
  const admin = await loginInNewContext(browser, BASE, 'admin');
  // getRoleMapping is the one settings request whose answer carries the viewer group name.
  const roleMapping = admin.page.waitForResponse(
    async (r) => r.url().includes('/_serverFn/') && (await r.text().catch(() => '')).includes('homelab-viewers'),
  );
  await admin.page.goto(`${BASE}/settings`);
  const url = (await roleMapping).url();
  const headers = { 'x-tsr-serverfn': 'true', 'sec-fetch-site': 'same-origin', origin: new URL(url).origin };

  const adminReplay = await admin.context.request.get(url, { headers });
  expect(adminReplay.status()).toBe(200);
  expect(await adminReplay.text()).toContain('homelab-viewers');
  await admin.context.close();

  const viewer = await loginInNewContext(browser, BASE, 'viewer');
  const viewerReplay = await viewer.context.request.get(url, { headers });
  const body = await viewerReplay.text();
  await viewer.context.close();

  expect(body).toContain('Insufficient permissions');
  expect(body).not.toContain('homelab-viewers');
});
