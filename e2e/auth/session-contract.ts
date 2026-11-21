import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import {
  expectClearedSessionCookie,
  expectIssuedSessionCookie,
  expectStateCookie,
  expectStoredSessionCookie,
  expectExpiresInTtl,
  findSetCookie,
} from './cookies';
import { emailOf, login } from './login';
import type { LaneUser } from './login';
import { expireSessionRow, sessionRow } from './session-db';

export interface ContractLane {
  base: string;
  cookieName: string;
  secure: boolean;
}

export async function loginInNewContext(browser: Browser, base: string, who: LaneUser = 'admin') {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const callback = await login(page, base, who);
  return { context, page, callback };
}

export async function sessionToken(page: Page, cookieName: string): Promise<string> {
  const cookie = (await page.context().cookies()).find((c) => c.name === cookieName);
  expect(cookie, `${cookieName} should be in the cookie jar`).toBeDefined();
  return cookie?.value ?? '';
}

/**
 * Loads the app as a signed-in user and returns the path of the getSession server function,
 * identified by the one `/_serverFn/` response that carries the user's email.
 */
export async function expectSignedIn(page: Page, base: string, email: string): Promise<string> {
  const found = page.waitForResponse(
    async (r) => r.url().includes('/_serverFn/') && (await r.text().catch(() => '')).includes(email),
  );
  await page.goto(`${base}/docker`);
  const response = await found;
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  return new URL(response.url()).pathname;
}

/** getSession must answer 200 without the user, so a server error cannot pass as a rejection. */
export async function expectSignedOut(page: Page, base: string, getSessionPath: string, email: string) {
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === getSessionPath);
  await page.goto(`${base}/docker`);
  const response = await answered;
  expect(response.status(), 'getSession should answer, not fail').toBe(200);
  expect(await response.text()).not.toContain(email);
  await expect(page).toHaveURL(/\/login/);
}

export function defineSessionContract({ base, cookieName, secure }: ContractLane) {
  const adminEmail = () => emailOf('admin');

  test('login issues the session cookie, accepted by the browser, backed by a row with the same TTL', async ({
    page,
    context,
  }) => {
    const callback = await login(page, base);

    const issued = await findSetCookie(callback, cookieName);
    expectIssuedSessionCookie(issued, secure);

    const cookies = await context.cookies();
    expectStoredSessionCookie(
      cookies.find((c) => c.name === cookieName),
      secure,
    );
    if (secure) expect(cookies.find((c) => c.name === 'session')).toBeUndefined();

    const row = await sessionRow(issued?.value ?? '');
    expect(row, 'the session row should exist').not.toBeNull();
    expectExpiresInTtl(row?.expires);
    expect(row?.role).toBe('admin');
  });

  test('login start sets the oidc_state cookie scoped to /api/auth', async ({ request }) => {
    const response = await request.get(`${base}/api/auth/login`, { maxRedirects: 0 });
    expectStateCookie(await findSetCookie(response, 'oidc_state'), secure);
  });

  test('the session persists into a fresh context', async ({ page, context, browser }) => {
    await login(page, base);
    await expectSignedIn(page, base, adminEmail());

    const fresh = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState: await context.storageState(),
    });
    await expectSignedIn(await fresh.newPage(), base, adminEmail());
    await fresh.close();
  });

  test('two logins issue different tokens, each with its own row', async ({ page, browser }) => {
    await login(page, base);
    const first = await sessionToken(page, cookieName);

    const other = await loginInNewContext(browser, base);
    const second = await sessionToken(other.page, cookieName);
    await other.context.close();

    expect(second).not.toBe(first);
    expect(await sessionRow(first)).not.toBeNull();
    expect(await sessionRow(second)).not.toBeNull();
  });

  test('a token with one character changed is rejected', async ({ page, context }) => {
    await login(page, base);
    const getSessionPath = await expectSignedIn(page, base, adminEmail());

    const stored = (await context.cookies()).find((c) => c.name === cookieName);
    if (!stored) throw new Error(`${cookieName} should be in the cookie jar`);
    const tampered = stored.value.slice(0, -1) + (stored.value.endsWith('0') ? '1' : '0');
    await context.clearCookies();
    await context.addCookies([{ ...stored, value: tampered }]);

    await expectSignedOut(page, base, getSessionPath, adminEmail());
  });

  test('a session row past its expiry is rejected', async ({ page }) => {
    await login(page, base);
    const getSessionPath = await expectSignedIn(page, base, adminEmail());

    await expireSessionRow(await sessionToken(page, cookieName));

    await expectSignedOut(page, base, getSessionPath, adminEmail());
  });

  test('logout clears the cookie and deletes the server-side session row', async ({
    page,
    context,
  }) => {
    await login(page, base);
    const token = await sessionToken(page, cookieName);
    expect(await sessionRow(token), 'the row exists before logout').not.toBeNull();

    // page.goto resolves to the last response of the IdP redirect chain, so the clearing Set-Cookie must be captured off the logout response.
    const logoutPromise = page.waitForResponse((r) => r.url().includes('/api/auth/logout'));
    await page.goto(`${base}/api/auth/logout`);
    expectClearedSessionCookie(await findSetCookie(await logoutPromise, cookieName), secure);

    expect((await context.cookies()).find((c) => c.name === cookieName)).toBeUndefined();
    expect(await sessionRow(token), 'the row is gone after logout').toBeNull();
  });
}
