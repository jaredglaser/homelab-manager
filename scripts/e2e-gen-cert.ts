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
