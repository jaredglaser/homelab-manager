import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Cookie, type Page, type Response } from '@playwright/test';
import { Pool } from 'pg';

interface OidcInfo {
  clientId: string;
  issuerUrl: string;
  email: string;
  userId: string;
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  attrs: Map<string, string>;
}

export const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_HOURS ?? '8') * 3600;

const TTL_TOLERANCE_SECONDS = 300;

export function readOidc(): OidcInfo {
  return JSON.parse(readFileSync(path.resolve('e2e-build/auth/oidc.json'), 'utf8')) as OidcInfo;
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
  return ((await res.json()) as { token: string }).token;
}

export function parseSetCookie(header: string): ParsedSetCookie {
  const [pair, ...rest] = header.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const attrs = new Map<string, string>();
  for (const part of rest) {
    const i = part.indexOf('=');
    attrs.set((i < 0 ? part : part.slice(0, i)).toLowerCase(), i < 0 ? '' : part.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

export async function findSetCookie(
  response: Response,
  name: string,
): Promise<ParsedSetCookie | undefined> {
  return (await response.headersArray())
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => parseSetCookie(h.value))
    .find((c) => c.name === name);
}

export function expectIssuedSessionCookie(cookie: ParsedSetCookie | undefined, secure: boolean) {
  expect(cookie, 'callback should set the session cookie').toBeDefined();
  expect(cookie?.value).toMatch(/^[0-9a-f]{64}$/);
  expect(cookie?.attrs.has('httponly')).toBe(true);
  expect(cookie?.attrs.has('secure')).toBe(secure);
  expect(cookie?.attrs.get('samesite')).toBe('Lax');
  expect(cookie?.attrs.get('path')).toBe('/');
  expect(cookie?.attrs.has('domain')).toBe(false);
  expect(cookie?.attrs.get('max-age')).toBe(String(SESSION_TTL_SECONDS));
}

export function expectClearedSessionCookie(cookie: ParsedSetCookie | undefined, secure: boolean) {
  expect(cookie, 'logout should clear the session cookie').toBeDefined();
  expect(cookie?.value).toBe('');
  expect(cookie?.attrs.get('max-age')).toBe('0');
  expect(cookie?.attrs.has('httponly')).toBe(true);
  expect(cookie?.attrs.has('secure')).toBe(secure);
  expect(cookie?.attrs.get('samesite')).toBe('Lax');
  expect(cookie?.attrs.get('path')).toBe('/');
}

export function expectStoredSessionCookie(stored: Cookie | undefined, secure: boolean) {
  expect(stored, 'the browser should accept and store the session cookie').toBeDefined();
  expect(stored?.httpOnly).toBe(true);
  expect(stored?.secure).toBe(secure);
  expect(stored?.sameSite).toBe('Lax');
  expect(stored?.path).toBe('/');
  const nowSeconds = Date.now() / 1000;
  expect(stored?.expires).toBeGreaterThan(nowSeconds + SESSION_TTL_SECONDS - TTL_TOLERANCE_SECONDS);
  expect(stored?.expires).toBeLessThan(nowSeconds + SESSION_TTL_SECONDS + TTL_TOLERANCE_SECONDS);
}

/** Epoch seconds at which the server-side session row for this raw token expires, or null when no row exists. */
export async function sessionRowExpiry(rawToken: string): Promise<number | null> {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? '5432'),
    database: process.env.POSTGRES_DB ?? 'homelab',
    user: process.env.POSTGRES_USER ?? 'homelab',
    password: process.env.POSTGRES_PASSWORD ?? '',
  });
  try {
    const hashedId = createHash('sha256').update(rawToken).digest('hex');
    const result = await pool.query<{ expires: number }>(
      'SELECT extract(epoch FROM expires_at)::float8 AS expires FROM sessions WHERE id = $1',
      [hashedId],
    );
    return result.rows[0]?.expires ?? null;
  } finally {
    await pool.end();
  }
}

export function expectRowExpiryMatchesTtl(expiry: number | null) {
  expect(expiry, 'the session row should exist').not.toBeNull();
  const nowSeconds = Date.now() / 1000;
  expect(expiry).toBeGreaterThan(nowSeconds + SESSION_TTL_SECONDS - TTL_TOLERANCE_SECONDS);
  expect(expiry).toBeLessThan(nowSeconds + SESSION_TTL_SECONDS + TTL_TOLERANCE_SECONDS);
}

/** The account menu renders only for a real (non-synthetic) user, and a negative URL assertion would pass before the client-side bounce to /login. */
export async function expectAuthenticated(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/docker`);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
}

export async function expectRedirectedToLogin(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/docker`);
  await expect(page).toHaveURL(/\/login/);
}

/**
 * Establishes a Pocket ID session via a one-time token, then runs the app's OIDC
 * login. Returns the `/api/auth/callback` response (the one that sets the session
 * cookie). `baseURL` is the app origin (http or https project).
 */
export async function login(page: Page, baseURL: string): Promise<Response> {
  const oidc = readOidc();
  const token = await mintOneTimeToken(oidc);

  // /lc redirects to a page that POSTs the token; moving on before that POST lands races the OIDC interaction into an error.
  await page.goto(`${oidc.issuerUrl}/lc/${token}`);
  await page.waitForResponse((r) => r.url().includes('/api/one-time-access-token/'));

  const callbackPromise = page.waitForResponse((r) => r.url().includes('/api/auth/callback'));
  await page.goto(`${baseURL}/api/auth/login`);

  // Pocket ID shows a consent screen on the first authorize and skips it afterwards, so the click races the callback.
  const consent = page.getByRole('button', { name: /authorize|allow|continue|consent|sign in/i });
  await Promise.race([callbackPromise, consent.click({ timeout: 15_000 }).catch(() => undefined)]);

  const callback = await callbackPromise;
  await page.waitForURL(`${baseURL}/docker`);
  return callback;
}
