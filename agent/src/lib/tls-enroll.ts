import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * POST /tls/enroll: the agent generates its own per-host TLS keypair with
 * openssl, writes cert.pem and key.pem (mode 0600) into a flat directory under
 * the stacks volume, and returns only the public certificate PEM. The manager
 * never receives the private key, so enrollment over the pre-TLS HTTP channel
 * cannot leak it.
 */

export const TLS_DIR_NAME = 'hlm-agent-tls';

const COMMON_NAME = 'hlm-agent-tls';
const KEY_BITS = '2048';
const CERT_DAYS = '3650';
const MAX_SANS = 32;

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

/**
 * Parses HLM_TLS_HTTP_FALLBACK. Undefined means off; the only accepted values
 * are 'true' and 'false', so a typo fails loudly instead of silently serving
 * plain HTTP.
 */
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

/**
 * Decides how the agent serves traffic given its configured TLS paths. A
 * configured but missing or unreadable certificate is fatal unless the
 * HLM_TLS_HTTP_FALLBACK opt-in is set: the manager pins the serving
 * certificate, so silently serving HTTP under a TLS URL would break every
 * connection without explanation.
 */
export function resolveTlsStartup(
  certPath: string | undefined,
  keyPath: string | undefined,
  fallback: boolean,
  isReadable: (path: string) => boolean,
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
        `${problem}. Serving HTTP because HLM_TLS_HTTP_FALLBACK=true; manager-to-agent connections run without TLS until TLS provisioning succeeds.`,
    };
  }
  return {
    mode: 'fatal',
    error:
      `${problem}. The agent refuses to serve without its certificate. Re-run TLS provisioning from the manager (it writes cert.pem and key.pem and restarts the agent), or set HLM_TLS_HTTP_FALLBACK=true to serve HTTP without TLS.`,
  };
}

export function isIpLiteral(value: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}

const DNS_LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?$/;

function isValidDnsName(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => DNS_LABEL_PATTERN.test(label));
}

/**
 * Validates the manager-dictated SAN list. Each entry must be an IP literal or
 * a DNS name; anything else (paths, traversal, whitespace) is rejected because
 * SAN text is embedded in an openssl argv and must never carry metacharacters.
 */
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
    const san = entry.trim();
    const valid = isIpLiteral(san) || isValidDnsName(san);
    if (!valid) {
      throw new TlsEnrollError(
        `Invalid SAN '${entry}': each entry must be a DNS name (letters, numbers, hyphens, dots) or an IP address`,
      );
    }
    if (!sans.some((existing) => existing.toLowerCase() === san.toLowerCase())) {
      sans.push(san);
    }
  }
  return sans;
}

export class TlsEnrollError extends Error {}

export function buildSubjectAltName(sans: string[]): string {
  return sans.map((san) => (isIpLiteral(san) ? `IP:${san}` : `DNS:${san}`)).join(',');
}

export async function handleTlsEnroll(
  request: Request,
  stacksDir: string,
  spawnFn: SpawnFn = realSpawn,
): Promise<Response> {
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

  mkdirSync(tlsDir, { recursive: true });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

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
      `subjectAltName=${buildSubjectAltName(sans)}`,
    ]);
    assertOpensslOk(certResult, 'certificate signing');
    writeFileSync(certPath, certResult.stdout, { mode: 0o600 });
    chmodSync(certPath, 0o600);
    return Response.json({ certPem: certResult.stdout });
  } catch (err) {
    try {
      unlinkSync(keyPath);
    } catch {
      // The key stays on disk if removal fails; the next enroll overwrites it.
    }
    return Response.json(
      { error: `Could not sign the TLS certificate: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

function assertOpensslOk(result: SpawnResult, step: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n')[0] || `openssl exited ${result.exitCode}`;
    throw new Error(`TLS ${step} failed: ${detail}`);
  }
}
