import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TLS_DIR_NAME = 'hlm-agent-tls';
// Presence of this dot-file next to the certs separates a first boot before
// enrollment (serve HTTP) from an enrolled host that lost its cert (fatal).
export const ENROLL_MARKER_NAME = '.enrolled';

const COMMON_NAME = 'hlm-agent-tls';
const KEY_BITS = '2048';
const CERT_DAYS = '3650';
const MAX_SANS = 32;
// The longest valid IPv6 text form is 45 characters.
const MAX_IP_SAN_LENGTH = 45;

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type SpawnFn = (command: string, args: string[]) => Promise<SpawnResult>;

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

export function parseTlsHttpFallback(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid HLM_TLS_HTTP_FALLBACK: '${value}'. Must be 'true' or 'false'.`);
}

export type TlsStartupDecision =
  | { mode: 'tls'; certPath: string; keyPath: string }
  | { mode: 'http'; warning?: string }
  | { mode: 'fatal'; error: string };

/** Missing cert plus no enrollment marker is a first boot served over HTTP with a warning. An enrolled host that lost its cert stays fatal, because silently serving HTTP under a pinned https URL breaks every connection unexplained. */
export function resolveTlsStartup(
  certPath: string | undefined,
  keyPath: string | undefined,
  fallback: boolean,
  isReadable: (path: string) => boolean,
  isEnrolled: () => boolean,
): TlsStartupDecision {
  if (!certPath && !keyPath) return { mode: 'http' };
  if (!certPath || !keyPath) {
    return {
      mode: 'fatal',
      error: 'Both TLS_CERT_PATH and TLS_KEY_PATH must be set together. Only one was provided.',
    };
  }
  if (isReadable(certPath) && isReadable(keyPath)) return { mode: 'tls', certPath, keyPath };
  const problem = `TLS certificate or key is missing or unreadable: '${certPath}' / '${keyPath}'`;
  if (fallback) {
    return {
      mode: 'http',
      warning:
        `${problem}. Serving HTTP because HLM_TLS_HTTP_FALLBACK=true. Manager-to-agent connections run without TLS until TLS provisioning succeeds.`,
    };
  }
  if (!isEnrolled()) {
    return {
      mode: 'http',
      warning:
        `${problem}. No enrollment marker found, so this is a first boot before TLS enrollment. Serving HTTP so the manager can enroll a certificate and restart the agent with TLS. If this host was enrolled before, its certificate was lost. Re-run TLS provisioning from the manager, or set HLM_TLS_HTTP_FALLBACK=true to keep serving HTTP.`,
    };
  }
  return {
    mode: 'fatal',
    error:
      `${problem}. The agent was enrolled before but its certificate is gone, so it refuses to serve. Re-run TLS provisioning from the manager, or set HLM_TLS_HTTP_FALLBACK=true to serve HTTP without TLS.`,
  };
}

function normalizeIpLiteral(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export function isIpLiteral(value: string): boolean {
  const bare = normalizeIpLiteral(value);
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4) return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  return /^[0-9a-fA-F:]+$/.test(bare) && bare.includes(':');
}

const DNS_LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?$/;

function isValidDnsName(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => DNS_LABEL_PATTERN.test(label));
}

// SAN text is spliced into an openssl argv: only IP literals and DNS names survive.
export function parseAndValidateSans(body: unknown): string[] {
  const raw = (body as { sans?: unknown } | null)?.sans;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TlsEnrollError('The enroll request requires a non-empty "sans" array of DNS names or IP addresses');
  }
  if (raw.length > MAX_SANS) {
    throw new TlsEnrollError(`The enroll request allows at most ${MAX_SANS} SANs`);
  }
  const sans: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new TlsEnrollError('Every SAN must be a string holding a DNS name or an IP address');
    }
    const san = normalizeIpLiteral(entry.trim());
    const valid = isIpLiteral(san) || isValidDnsName(san);
    if (!valid) {
      throw new TlsEnrollError(
        `Invalid SAN '${entry}': each entry must be a DNS name (letters, numbers, hyphens, dots) or an IP address`,
      );
    }
    if (isIpLiteral(san) && san.length > MAX_IP_SAN_LENGTH) {
      throw new TlsEnrollError(`Invalid SAN '${entry}': an IP literal is at most ${MAX_IP_SAN_LENGTH} characters`);
    }
    if (!sans.some((existing) => existing.toLowerCase() === san.toLowerCase())) {
      sans.push(san);
    }
  }
  return sans;
}

export class TlsEnrollError extends Error {}

export function buildSubjectAltName(sans: string[]): string {
  return sans.map((san) => (isIpLiteral(san) ? `IP:${normalizeIpLiteral(san)}` : `DNS:${san}`)).join(',');
}

export function enrollMarkerPath(stacksDir: string): string {
  return join(stacksDir, TLS_DIR_NAME, ENROLL_MARKER_NAME);
}

// One enroll at a time: concurrent enrolls could otherwise rename a mismatched
// key and cert pair into place.
let enrollChain: Promise<unknown> = Promise.resolve();

export function handleTlsEnroll(
  request: Request,
  stacksDir: string,
  spawnFn: SpawnFn = realSpawn,
): Promise<Response> {
  const result = enrollChain.then(() => enroll(request, stacksDir, spawnFn));
  enrollChain = result.catch(() => undefined);
  return result;
}

async function enroll(request: Request, stacksDir: string, spawnFn: SpawnFn): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The enroll request requires a JSON body with a "sans" array' }, { status: 400 });
  }

  let sans: string[];
  try {
    sans = parseAndValidateSans(body);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Invalid enroll request' }, { status: 400 });
  }

  const tlsDir = join(stacksDir, TLS_DIR_NAME);
  const certPath = join(tlsDir, 'cert.pem');
  const keyPath = join(tlsDir, 'key.pem');
  const token = randomBytes(8).toString('hex');
  const stagedKeyPath = join(tlsDir, `.key-${token}.tmp`);
  const stagedCertPath = join(tlsDir, `.cert-${token}.tmp`);

  let keyPem: string;
  try {
    const keyResult = await spawnFn('openssl', [
      'genpkey',
      '-algorithm',
      'RSA',
      '-pkeyopt',
      `rsa_keygen_bits:${KEY_BITS}`,
    ]);
    assertOpensslOk(keyResult, 'private key generation');
    keyPem = keyResult.stdout;
  } catch (err) {
    return Response.json(
      { error: `Could not generate the TLS private key: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  try {
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(stagedKeyPath, keyPem, { mode: 0o600 });
    chmodSync(stagedKeyPath, 0o600);
  } catch (err) {
    removeQuietly(stagedKeyPath);
    return Response.json(
      { error: `Could not write the TLS key material: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  let certPem: string;
  try {
    const certResult = await spawnFn('openssl', [
      'req',
      '-new',
      '-x509',
      '-days',
      CERT_DAYS,
      '-key',
      stagedKeyPath,
      '-subj',
      `/CN=${COMMON_NAME}`,
      '-addext',
      `subjectAltName=${buildSubjectAltName(sans)}`,
    ]);
    assertOpensslOk(certResult, 'certificate signing');
    certPem = certResult.stdout;
  } catch (err) {
    removeQuietly(stagedKeyPath);
    return Response.json(
      { error: `Could not sign the TLS certificate: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // Rename into place only after signing succeeds, so an interrupted enroll
  // leaves the previous key and cert pair intact and consistent.
  try {
    writeFileSync(stagedCertPath, certPem, { mode: 0o600 });
    chmodSync(stagedCertPath, 0o600);
    renameSync(stagedKeyPath, keyPath);
    renameSync(stagedCertPath, certPath);
    writeFileSync(enrollMarkerPath(stacksDir), new Date().toISOString());
    return Response.json({ certPem });
  } catch (err) {
    removeQuietly(stagedKeyPath);
    removeQuietly(stagedCertPath);
    return Response.json(
      { error: `Could not write the TLS key material: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already renamed or never written.
  }
}

function assertOpensslOk(result: SpawnResult, step: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n')[0] || `openssl exited ${result.exitCode}`;
    throw new Error(`TLS ${step} failed: ${detail}`);
  }
}
