import { createHash } from 'node:crypto';

/**
 * SHA-256 over the certificate's DER. The agent carries its own copy of this, and each side pins the
 * same fixture in a test, so the two cannot drift apart without failing both suites.
 */
export function certificateFingerprint(pem: string): string {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
}
