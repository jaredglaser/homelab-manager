import { expect, test } from '@playwright/test';
import { findSetCookie } from './auth/cookies';
import { emailOf, loginDenied } from './auth/login';
import { defineSessionContract, loginInNewContext, sessionToken } from './auth/session-contract';
import { sessionCountForEmail, sessionRow } from './auth/session-db';

const BASE = 'http://localhost:3201';

defineSessionContract({ base: BASE, cookieName: 'session', secure: false });

test('the viewer group maps to the viewer role', async ({ browser }) => {
  const viewer = await loginInNewContext(browser, BASE, 'viewer');
  const row = await sessionRow(await sessionToken(viewer.page, 'session'));
  await viewer.context.close();

  expect(row?.role).toBe('viewer');
  expect(row?.email).toBe(emailOf('viewer'));
});

test('a user in no mapped group is sent to /denied without a session', async ({ page }) => {
  const callback = await loginDenied(page, BASE);

  expect(callback.status()).toBe(302);
  expect(await findSetCookie(callback, 'session')).toBeUndefined();
  expect(await sessionCountForEmail(emailOf('denied'))).toBe(0);
  await expect(page.getByText("You don't have access to this application")).toBeVisible();
});
