/**
 * A deployment uses exactly one session cookie name, chosen by isSecure. http
 * (local dev) cannot use the __Host- prefix because browsers reject it without
 * Secure, so build, clear, and parse must all key off the same flag or a request
 * is read under a name that was never issued.
 */
export const SESSION_COOKIE_NAME = 'session';
export const HOST_SESSION_COOKIE_NAME = '__Host-session';

export function getSessionCookieName(isSecure: boolean): string {
  return isSecure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** @param maxAgeSeconds - Cookie lifetime, mirrors the DB session TTL so the cookie survives browser restarts for exactly as long as the server-side session. */
export function buildSessionCookie(
  rawToken: string,
  isSecure: boolean,
  maxAgeSeconds: number,
): string {
  const securePart = isSecure ? ' Secure;' : '';
  const name = getSessionCookieName(isSecure);
  return `${name}=${encodeURIComponent(rawToken)}; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function buildClearSessionCookie(isSecure: boolean): string {
  const securePart = isSecure ? ' Secure;' : '';
  const name = getSessionCookieName(isSecure);
  return `${name}=; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=0`;
}

/** Reads only the name matching isSecure, so on https a plain "session" cookie planted by a subdomain cannot fixate a session under the __Host- name. */
export function parseSessionCookie(header: string | null, isSecure: boolean): string | null {
  return parseCookie(header, getSessionCookieName(isSecure));
}
