import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { certificateFingerprint } from '../cert-fingerprint';

describe('certificateFingerprint', () => {
  it('digests a certificate the way the manager computes it', () => {
    // Same fixture as the manager's copy of this test, so the two cannot drift apart.
    const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from('hello').toString('base64')}\n-----END CERTIFICATE-----\n`;
    const expected = 'SHA256:' + createHash('sha256').update('hello').digest('base64').replace(/=+$/, '');
    expect(certificateFingerprint(pem)).toBe(expected);
  });

  it('ignores the headers and line breaks a PEM carries', () => {
    const base64 = Buffer.from('hello').toString('base64');
    const oneLine = `-----BEGIN CERTIFICATE-----${base64}-----END CERTIFICATE-----`;
    const wrapped = `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
    expect(certificateFingerprint(oneLine)).toBe(certificateFingerprint(wrapped));
  });
});
