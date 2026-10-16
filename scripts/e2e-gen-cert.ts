/**
 * Generates a self-signed localhost certificate for the auth e2e lane's https
 * server. Chromium treats https://localhost as a secure context, so the app
 * issues the __Host-/Secure cookie and the browser accepts it; Playwright runs
 * with `ignoreHTTPSErrors` so the self-signed cert is fine.
 *
 * Output: e2e-build/auth/certs/{cert.pem,key.pem} (gitignored). Idempotent;
 * regenerates on each run so an expired cert never lingers.
 *
 * Usage: bun scripts/e2e-gen-cert.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('e2e-build/auth/certs');
mkdirSync(outDir, { recursive: true });

const keyPath = path.join(outDir, 'key.pem');
const certPath = path.join(outDir, 'cert.pem');

execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '7',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'inherit' },
);

console.info(`[e2e-gen-cert] wrote ${certPath} and ${keyPath}`);
