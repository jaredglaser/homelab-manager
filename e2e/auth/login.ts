import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Page, type Response } from '@playwright/test';

/**
 * Helpers for the real-server auth lane. They drive a genuine OIDC login against
 * Pocket ID and return the real callback response so specs can assert the actual
 * Set-Cookie the browser received (the thing Happy-DOM cannot test).
 *
 * Login uses Pocket ID's one-time access token (`/lc/<token>`), minted fresh per
 * call via the admin API, so each browser context gets its own provider session
 * without passkey automation and without exhausting a single-use token.
 */
interface OidcInfo {
  clientId: string;
  issuerUrl: string;
  email: string;
  userId: string;
}

export function readOidc(): OidcInfo {
  return JSON.parse(readFileSync(path.resolve('e2e-build/auth/oidc.json'), 'utf8'));
}

function apiKey(): string {
  const key = process.env.POCKET_ID_API_KEY;
  if (!key) throw new Error('POCKET_ID_API_KEY must be set for the auth e2e lane');
  return key;
}

async function mintOneTimeToken(oidc: OidcInfo): Promise<string> {
  const res = await fetch(`${oidc.issuerUrl}/api/users/${oidc.userId}/one-time-access-token`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: '1h' }),
  });
  if (!res.ok) throw new Error(`mint one-time token failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

/** Returns the Set-Cookie header values from a response (one entry per cookie). */
export async function setCookieValues(response: Response): Promise<string[]> {
  return (await response.headersArray())
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
}

/**
 * Establishes a Pocket ID session via a one-time token, then runs the app's OIDC
 * login. Returns the `/api/auth/callback` response (the one that sets the session
 * cookie). `baseURL` is the app origin (http or https project).
 */
export async function login(page: Page, baseURL: string): Promise<Response> {
  const oidc = readOidc();
  const token = await mintOneTimeToken(oidc);

  // Consume the one-time token: this logs the browser into Pocket ID.
  await page.goto(`${oidc.issuerUrl}/lc/${token}`);

  const callbackPromise = page.waitForResponse((r) => r.url().includes('/api/auth/callback'));
  await page.goto(`${baseURL}/api/auth/login`);

  // First authorize for this user+client may show a consent screen; later ones are
  // remembered server-side. Click through if present, otherwise proceed.
  const consent = page.getByRole('button', { name: /authorize|allow|continue|consent/i });
  await consent.click({ timeout: 3000 }).catch(() => {});

  const callback = await callbackPromise;
  await page.waitForURL(`${baseURL}/`);
  return callback;
}
