import { describe, it, expect } from 'bun:test';
import {
  SESSION_COOKIE_NAME,
  HOST_SESSION_COOKIE_NAME,
  getSessionCookieName,
  buildSessionCookie,
  buildClearSessionCookie,
  parseCookie,
  parseSessionCookie,
} from '@/lib/auth/session-cookie';

describe('parseCookie', () => {
  it('returns the value for a matching cookie', () => {
    expect(parseCookie('session=abc123', 'session')).toBe('abc123');
  });

  it('returns null when header is null', () => {
    expect(parseCookie(null, 'session')).toBeNull();
  });

  it('returns null when cookie name not present', () => {
    expect(parseCookie('other=xyz', 'session')).toBeNull();
  });

  it('handles multiple cookies and returns the right one', () => {
    expect(parseCookie('foo=bar; session=tok123; baz=qux', 'session')).toBe('tok123');
  });

  it('URL-decodes the cookie value', () => {
    const encoded = encodeURIComponent('value with spaces');
    expect(parseCookie(`session=${encoded}`, 'session')).toBe('value with spaces');
  });

  it('returns null for empty header string', () => {
    expect(parseCookie('', 'session')).toBeNull();
  });
});

describe('getSessionCookieName', () => {
  it('returns the __Host- prefixed name when secure', () => {
    expect(getSessionCookieName(true)).toBe(HOST_SESSION_COOKIE_NAME);
  });

  it('returns the plain name when not secure', () => {
    expect(getSessionCookieName(false)).toBe(SESSION_COOKIE_NAME);
  });
});

describe('buildSessionCookie', () => {
  it('includes HttpOnly, SameSite=Lax, Path=/, and Max-Age for non-secure', () => {
    const cookie = buildSessionCookie('my-raw-token', false, 28800);
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie).not.toContain('Secure');
  });

  it('uses the __Host- name and Secure flag when isSecure=true', () => {
    const cookie = buildSessionCookie('my-raw-token', true, 3600);
    expect(cookie).toMatch(/^__Host-session=/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('encodes the raw token in the cookie value', () => {
    const token = 'raw/token+value';
    const cookie = buildSessionCookie(token, false, 60);
    expect(cookie).toContain(`session=${encodeURIComponent(token)}`);
  });
});

describe('buildClearSessionCookie', () => {
  it('returns the plain clear cookie when not secure', () => {
    const cookie = buildClearSessionCookie(false);
    expect(cookie).toMatch(/^session=;/);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('returns the __Host- clear cookie when secure', () => {
    const cookie = buildClearSessionCookie(true);
    expect(cookie).toMatch(/^__Host-session=;/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
  });
});

describe('parseSessionCookie', () => {
  it('returns null for a null header', () => {
    expect(parseSessionCookie(null, false)).toBeNull();
    expect(parseSessionCookie(null, true)).toBeNull();
  });

  it('returns null when the active name is not present', () => {
    expect(parseSessionCookie('other=abc; foo=bar', false)).toBeNull();
  });

  it('reads the plain session cookie when not secure', () => {
    expect(parseSessionCookie('foo=bar; session=tok123; baz=qux', false)).toBe('tok123');
  });

  it('reads the __Host-session cookie when secure', () => {
    expect(parseSessionCookie('foo=bar; __Host-session=tok456', true)).toBe('tok456');
  });

  it('ignores the plain name when secure', () => {
    // A plain "session" cookie planted by a subdomain must not fixate a session.
    expect(parseSessionCookie('session=legacy-tok', true)).toBeNull();
  });

  it('ignores the __Host- name when not secure', () => {
    expect(parseSessionCookie('__Host-session=host-tok', false)).toBeNull();
  });

  it('URL-decodes the token value', () => {
    const token = 'token with spaces';
    expect(parseSessionCookie(`__Host-session=${encodeURIComponent(token)}`, true)).toBe(token);
  });

  it('returns null when the value is malformed percent-encoding', () => {
    expect(parseSessionCookie('session=%E0%A4%A', false)).toBeNull();
  });

  it('does not treat "__Host-session=" as the plain "session=" name', () => {
    // The plain-name regex must not match "session=" inside "__Host-session=".
    expect(parseSessionCookie('__Host-session=only-host', false)).toBeNull();
    expect(parseSessionCookie('x__Host-session=weird', false)).toBeNull();
  });
});
