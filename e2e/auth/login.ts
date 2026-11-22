import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';

export type LaneUser = 'admin' | 'viewer' | 'denied';

interface OidcUser {
  userId: string;
  email: string;
}

interface OidcInfo {
  clientId: string;
  issuerUrl: string;
  users: Record<LaneUser, OidcUser>;
}

export function readOidc(): OidcInfo {
  return JSON.parse(readFileSync(path.resolve('e2e-build/auth/oidc.json'), 'utf8')) as OidcInfo;
}

export function emailOf(who: LaneUser): string {
  return readOidc().users[who].email;
}

function apiKey(): string {
  const key = process.env.POCKET_ID_API_KEY;
  if (!key) throw new Error('POCKET_ID_API_KEY must be set for the auth e2e lane');
  return key;
}

async function mintOneTimeToken(oidc: OidcInfo, who: LaneUser): Promise<string> {
  const res = await fetch(
    `${oidc.issuerUrl}/api/users/${oidc.users[who].userId}/one-time-access-token`,
    {
      method: 'POST',
      headers: { 'X-API-Key': apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: '1h' }),
    },
  );
  if (!res.ok) throw new Error(`mint one-time token failed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function runOidcLogin(
  page: Page,
  baseURL: string,
  who: LaneUser,
  landing: string,
): Promise<Response> {
  const oidc = readOidc();
  const token = await mintOneTimeToken(oidc, who);

  // /lc redirects to a page that POSTs the token, and moving on before that POST lands races the OIDC interaction into an error.
  const tokenPosted = page.waitForResponse((r) => r.url().includes('/api/one-time-access-token/'));
  await page.goto(`${oidc.issuerUrl}/lc/${token}`);
  await tokenPosted;

  const callbackPromise = page.waitForResponse((r) => r.url().includes('/api/auth/callback'));
  await page.goto(`${baseURL}/api/auth/login`);

  // Pocket ID shows a consent screen on the first authorize and skips it afterwards, so the click races the callback.
  const consent = page.getByRole('button', { name: /authorize|allow|continue|consent|sign in/i });
  await Promise.race([callbackPromise, consent.click({ timeout: 15_000 }).catch(() => undefined)]);

  const callback = await callbackPromise;
  await page.waitForURL(`${baseURL}${landing}`);
  return callback;
}

/** Returns the `/api/auth/callback` response, the one that sets the session cookie. */
export async function login(
  page: Page,
  baseURL: string,
  who: LaneUser = 'admin',
): Promise<Response> {
  return await runOidcLogin(page, baseURL, who, '/docker');
}

/** A user in no mapped group is redirected to /denied and never gets a session. */
export async function loginDenied(page: Page, baseURL: string): Promise<Response> {
  return await runOidcLogin(page, baseURL, 'denied', '/denied');
}
