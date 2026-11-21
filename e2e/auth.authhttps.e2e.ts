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

const BASE = 'https://localhost:3202';

test('login issues __Host-session, accepted by the browser, backed by a row with the same TTL', async ({
  page,
  context,
}) => {
  const callback = await login(page, BASE);

  const issued = await findSetCookie(callback, '__Host-session');
  expectIssuedSessionCookie(issued, true);

  // Chromium silently drops a malformed __Host- cookie, so its presence in the jar is the acceptance proof.
  const cookies = await context.cookies();
  expectStoredSessionCookie(
    cookies.find((c) => c.name === '__Host-session'),
    true,
  );
  expect(cookies.find((c) => c.name === 'session')).toBeUndefined();

  expectRowExpiryMatchesTtl(await sessionRowExpiry(issued?.value ?? ''));
});

test('a valid token planted under the plain session name does not authenticate', async ({
  page,
  context,
}) => {
  await login(page, BASE);
  const token = (await context.cookies()).find((c) => c.name === '__Host-session')?.value ?? '';
  await expectAuthenticated(page, BASE);

  // The token is real, so only the single-name read keeps this request unauthenticated.
  await context.clearCookies();
  await context.addCookies([{ name: 'session', value: token, domain: 'localhost', path: '/' }]);

  await expectRedirectedToLogin(page, BASE);
});

test('logout clears __Host-session and deletes the server-side session row', async ({
  page,
  context,
}) => {
  await login(page, BASE);
  const token = (await context.cookies()).find((c) => c.name === '__Host-session')?.value ?? '';
  expect(await sessionRowExpiry(token), 'the row exists before logout').not.toBeNull();

  // page.goto resolves to the last response of the IdP redirect chain, so the clearing Set-Cookie must be captured off the logout response.
  const logoutPromise = page.waitForResponse((r) => r.url().includes('/api/auth/logout'));
  await page.goto(`${BASE}/api/auth/logout`);
  expectClearedSessionCookie(await findSetCookie(await logoutPromise, '__Host-session'), true);

  expect((await context.cookies()).find((c) => c.name === '__Host-session')).toBeUndefined();
  expect(await sessionRowExpiry(token), 'the row is gone after logout').toBeNull();
});
