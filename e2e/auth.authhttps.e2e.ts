import { test } from '@playwright/test';
import { emailOf, login } from './auth/login';
import {
  defineSessionContract,
  expectSignedIn,
  expectSignedOut,
  plantCookie,
  sessionToken,
} from './auth/session-contract';

const BASE = 'https://localhost:3202';

defineSessionContract({ base: BASE, cookieName: '__Host-session', secure: true });

test('a valid token planted under the plain session name does not authenticate', async ({
  page,
  context,
}) => {
  await login(page, BASE);
  const token = await sessionToken(page, '__Host-session');
  const getSessionPath = await expectSignedIn(page, BASE, emailOf('admin'));

  // The token is real, so only the single-name read keeps this request unauthenticated.
  await context.clearCookies();
  await plantCookie(context, { name: 'session', value: token, domain: 'localhost', path: '/' });

  await expectSignedOut(page, BASE, getSessionPath, { name: 'session', value: token });
});
