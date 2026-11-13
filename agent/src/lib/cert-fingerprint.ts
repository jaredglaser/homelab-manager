import { createHash } from 'node:crypto';

/** SHA-256 over the certificate's DER, presented the way ssh-keygen prints a host key so it can be compared by eye. */
export function certificateFingerprint(pem: string): string {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
}
