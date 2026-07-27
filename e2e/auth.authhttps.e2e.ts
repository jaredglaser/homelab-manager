import { test, expect } from '@playwright/test';
import { login, setCookieValues } from './auth/login';

/**
 * https deployment: the app issues `__Host-session` + Secure. https://localhost
 * is a secure context in Chromium, so the browser accepts the prefixed/Secure
 * cookie (a malformed __Host- cookie would be silently dropped, so its presence
 * in the jar is the acceptance proof). Also asserts the single-name read: on
 * https a planted plain `session` cookie must not authenticate. baseURL is
 * https://localhost:3202 (auth-https project).
 */
const BASE = 'https://localhost:3202';

test('login issues a __Host-session cookie with Secure and Max-Age', async ({ page, context }) => {
  const callback = await login(page, BASE);

  const cookie = (await setCookieValues(callback)).find((c) => c.startsWith('__Host-session='));
  expect(cookie, 'callback should set a __Host-session cookie').toBeTruthy();
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  expect(cookie).toContain('Path=/');
  expect(cookie).toMatch(/Max-Age=\d+/);

  const stored = (await context.cookies()).find((c) => c.name === '__Host-session');
  expect(stored, '__Host- cookie must be accepted and stored by the browser').toBeTruthy();
  expect(stored?.secure).toBe(true);
  expect(stored?.httpOnly).toBe(true);
  // The plain name must not be present on https.
  expect((await context.cookies()).find((c) => c.name === 'session')).toBeUndefined();
});

test('a planted plain session cookie does not authenticate on https', async ({ page, context }) => {
  // No login: forge a plain `session` cookie (the kind a subdomain could plant).
  await context.addCookies([
    { name: 'session', value: 'forged-token', domain: 'localhost', path: '/' },
  ]);

  await page.goto(`${BASE}/`);
  // The app reads only __Host-session on https, so this request is unauthenticated.
  await expect(page).toHaveURL(/\/login/);
});

test('logout clears the __Host-session cookie', async ({ page, context }) => {
  await login(page, BASE);

  const logout = await page.goto(`${BASE}/api/auth/logout`);
  const cleared = (await setCookieValues(logout!)).find((c) => c.startsWith('__Host-session='));
  expect(cleared).toContain('Max-Age=0');

  expect((await context.cookies()).find((c) => c.name === '__Host-session')).toBeUndefined();
});
