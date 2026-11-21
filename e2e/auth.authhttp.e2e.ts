import { test, expect } from '@playwright/test';
import {
  expectAuthenticated,
  expectClearedSessionCookie,
  expectIssuedSessionCookie,
  expectRedirectedToLogin,
  expectRowExpiryMatchesTtl,
  expectStoredSessionCookie,
  findSetCookie,
  login,
  sessionRowExpiry,
} from './auth/login';

const BASE = 'http://localhost:3201';

test('login issues the plain session cookie, stored by the browser, backed by a row with the same TTL', async ({
  page,
  context,
}) => {
  const callback = await login(page, BASE);

  const issued = await findSetCookie(callback, 'session');
  expectIssuedSessionCookie(issued, false);

  const stored = (await context.cookies()).find((c) => c.name === 'session');
  expectStoredSessionCookie(stored, false);

  expectRowExpiryMatchesTtl(await sessionRowExpiry(issued?.value ?? ''));
});

test('the session persists into a fresh context', async ({ page, context, browser }) => {
  await login(page, BASE);

  const fresh = await browser.newContext({ storageState: await context.storageState() });
  await expectAuthenticated(await fresh.newPage(), BASE);
  await fresh.close();
});

test('a cookie that was never issued does not authenticate', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: '0'.repeat(64), url: BASE }]);
  await expectRedirectedToLogin(await context.newPage(), BASE);
  await context.close();
});

test('logout clears the cookie and deletes the server-side session row', async ({
  page,
  context,
}) => {
  await login(page, BASE);
  const token = (await context.cookies()).find((c) => c.name === 'session')?.value ?? '';
  expect(await sessionRowExpiry(token), 'the row exists before logout').not.toBeNull();

  // page.goto resolves to the last response of the IdP redirect chain, so the clearing Set-Cookie must be captured off the logout response.
  const logoutPromise = page.waitForResponse((r) => r.url().includes('/api/auth/logout'));
  await page.goto(`${BASE}/api/auth/logout`);
  expectClearedSessionCookie(await findSetCookie(await logoutPromise, 'session'), false);

  expect((await context.cookies()).find((c) => c.name === 'session')).toBeUndefined();
  expect(await sessionRowExpiry(token), 'the row is gone after logout').toBeNull();
});
