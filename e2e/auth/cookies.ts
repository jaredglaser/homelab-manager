import { expect } from '@playwright/test';
import type { Cookie } from '@playwright/test';
import { LANE_SESSION_TTL_SECONDS } from './lane-config';

export interface ParsedSetCookie {
  name: string;
  value: string;
  attrs: Map<string, string>;
}

interface HeaderSource {
  headersArray(): { name: string; value: string }[] | Promise<{ name: string; value: string }[]>;
}

const TTL_TOLERANCE_SECONDS = 300;

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
  response: HeaderSource,
  name: string,
): Promise<ParsedSetCookie | undefined> {
  return (await response.headersArray())
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => parseSetCookie(h.value))
    .find((c) => c.name === name);
}

function expectAttributeSet(cookie: ParsedSetCookie | undefined, secure: boolean) {
  const expected = ['httponly', 'max-age', 'path', 'samesite', ...(secure ? ['secure'] : [])];
  expect([...(cookie?.attrs.keys() ?? [])].sort()).toEqual(expected.sort());
  expect(cookie?.attrs.get('samesite')).toBe('Lax');
  expect(cookie?.attrs.get('path')).toBe('/');
}

export function expectIssuedSessionCookie(cookie: ParsedSetCookie | undefined, secure: boolean) {
  expect(cookie, 'callback should set the session cookie').toBeDefined();
  expect(cookie?.value).toMatch(/^[0-9a-f]{64}$/);
  expectAttributeSet(cookie, secure);
  expect(cookie?.attrs.get('max-age')).toBe(String(LANE_SESSION_TTL_SECONDS));
}

export function expectClearedSessionCookie(cookie: ParsedSetCookie | undefined, secure: boolean) {
  expect(cookie, 'logout should clear the session cookie').toBeDefined();
  expect(cookie?.value).toBe('');
  expectAttributeSet(cookie, secure);
  expect(cookie?.attrs.get('max-age')).toBe('0');
}

export function expectStateCookie(cookie: ParsedSetCookie | undefined, secure: boolean) {
  expect(cookie, 'login should set the oidc_state cookie').toBeDefined();
  const expected = ['httponly', 'max-age', 'path', 'samesite', ...(secure ? ['secure'] : [])];
  expect([...(cookie?.attrs.keys() ?? [])].sort()).toEqual(expected.sort());
  expect(cookie?.attrs.get('path')).toBe('/api/auth');
  expect(cookie?.attrs.get('samesite')).toBe('Lax');
  expect(cookie?.attrs.get('max-age')).toBe('600');
}

export function expectExpiresInTtl(expiresSeconds: number | undefined) {
  const nowSeconds = Date.now() / 1000;
  expect(expiresSeconds).toBeGreaterThan(nowSeconds + LANE_SESSION_TTL_SECONDS - TTL_TOLERANCE_SECONDS);
  expect(expiresSeconds).toBeLessThan(nowSeconds + LANE_SESSION_TTL_SECONDS + TTL_TOLERANCE_SECONDS);
}

export function expectStoredSessionCookie(stored: Cookie | undefined, secure: boolean) {
  expect(stored, 'the browser should accept and store the session cookie').toBeDefined();
  expect(stored?.httpOnly).toBe(true);
  expect(stored?.secure).toBe(secure);
  expect(stored?.sameSite).toBe('Lax');
  expect(stored?.path).toBe('/');
  expectExpiresInTtl(stored?.expires);
}
