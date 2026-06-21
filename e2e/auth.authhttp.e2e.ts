import { test, expect } from '@playwright/test';
import { login, setCookieValues } from './auth/login';

/**
 * http deployment: the app issues the plain `session` cookie (no __Host-, no
 * Secure). Asserts the real Set-Cookie header and the browser's stored cookie,
 * then proves persistence (the cookie is sent back and validated) and that
 * logout clears it. baseURL is http://localhost:3201 (auth-http project).
 */
const BASE = 'http://localhost:3201';

test('login issues a plain session cookie with Max-Age and HttpOnly, no Secure', async ({
  page,
  context,
}) => {
  const callback = await login(page, BASE);

  const session = (await setCookieValues(callback)).find((c) => c.startsWith('session='));
  expect(session, 'callback should set a session cookie').toBeTruthy();
  expect(session).not.toContain('__Host-');
  expect(session).toMatch(/Max-Age=\d+/);
  expect(session).toContain('HttpOnly');
  expect(session).toContain('SameSite=Lax');
  expect(session).toContain('Path=/');
  expect(session).not.toContain('Secure');

  const stored = (await context.cookies()).find((c) => c.name === 'session');
  expect(stored?.httpOnly).toBe(true);
  expect(stored?.secure).toBe(false);
  // Max-Age set => a real expiry (not a -1 browser-session cookie).
  expect(stored?.expires).toBeGreaterThan(0);
});

test('the session persists into a fresh context (cookie is sent back and validated)', async ({
  page,
  context,
  browser,
}) => {
  await login(page, BASE);

  const fresh = await browser.newContext({ storageState: await context.storageState() });
  const freshPage = await fresh.newPage();
  await freshPage.goto(`${BASE}/`);
  // Authenticated requests stay on the app; an invalid/missing session bounces to /login.
  await expect(freshPage).not.toHaveURL(/\/login/);
  await fresh.close();
});

test('logout clears the session cookie', async ({ page, context }) => {
  await login(page, BASE);

  const logout = await page.goto(`${BASE}/api/auth/logout`);
  const cleared = (await setCookieValues(logout!)).find((c) => c.startsWith('session='));
  expect(cleared).toContain('Max-Age=0');

  expect((await context.cookies()).find((c) => c.name === 'session')).toBeUndefined();
});
