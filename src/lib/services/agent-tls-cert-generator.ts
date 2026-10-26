import { spawn } from 'node:child_process';
import { mkdtempSync, unlinkSync, writeFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TlsCertRequest {
  /** DNS name or IP literal the manager connects to; always covered by a SAN. */
  hostname: string;
  /** Resolved IP of the host, when known; covered by an IP SAN. */
  ip?: string;
  /** Extra DNS names the certificate must verify for (internal service names). */
  extraDnsNames?: string[];
}

export interface TlsCertMaterial {
  certPem: string;
  keyPem: string;
}

const KEY_BITS = '2048';
const CERT_DAYS = '3650';
const COMMON_NAME = 'hlm-agent-tls';

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

type SpawnFn = (command: string, args: string[]) => Promise<SpawnResult>;

const realSpawn: SpawnFn = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });

function buildSubjectAltName(request: TlsCertRequest): string {
  const entries: string[] = [];
  entries.push(isIp(request.hostname) ? `IP:${request.hostname}` : `DNS:${request.hostname}`);
  if (request.ip && request.ip !== request.hostname) {
    entries.push(`IP:${request.ip}`);
  }
  for (const name of request.extraDnsNames ?? []) {
    if (!entries.some((entry) => entry.toLowerCase() === `dns:${name.toLowerCase()}`)) {
      entries.push(`DNS:${name}`);
    }
  }
  return entries.join(',');
}

function isIp(value: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}

/**
 * Self-signed cert via argv-array openssl spawns, key first. The key is staged
 * in a 0600 temp file: /dev/stdin cannot be reopened when the child's stdin is a pipe.
 */
export async function generateTlsCert(request: TlsCertRequest, spawnFn: SpawnFn = realSpawn): Promise<TlsCertMaterial> {
  const keyResult = await spawnFn('openssl', [
    'genpkey',
    '-algorithm',
    'RSA',
    '-pkeyopt',
    `rsa_keygen_bits:${KEY_BITS}`,
  ]);
  assertOpensslOk(keyResult, 'private key generation');
  const keyPem = keyResult.stdout;

  const tempDir = mkdtempSync(join(tmpdir(), 'hlm-agent-tls-'));
  const keyPath = join(tempDir, 'key.pem');
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  try {
    const certResult = await spawnFn('openssl', [
      'req',
      '-new',
      '-x509',
      '-days',
      CERT_DAYS,
      '-key',
      keyPath,
      '-subj',
      `/CN=${COMMON_NAME}`,
      '-addext',
      `subjectAltName=${buildSubjectAltName(request)}`,
    ]);
    assertOpensslOk(certResult, 'certificate signing');
    return { certPem: certResult.stdout, keyPem };
  } finally {
    unlinkSync(keyPath);
    rmdirSync(tempDir);
  }
}

function assertOpensslOk(result: SpawnResult, step: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n')[0] || `openssl exited ${result.exitCode}`;
    throw new Error(`TLS certificate ${step} failed: ${detail}`);
  }
}
