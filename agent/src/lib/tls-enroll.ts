import { spawn } from 'node:child_process';
import { verifyPayloadSignature } from './jwt-auth';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TLS_DIR_NAME = 'hlm-agent-tls';

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

export type TlsStartupDecision =
  | { mode: 'tls'; certPath: string; keyPath: string }
  | { mode: 'http'; warning?: string; /** TLS was configured but no certificate is being served: only the enrollment endpoints may be served over plain HTTP. */ restricted: boolean }
  | { mode: 'fatal'; error: string };

/**
 * Paths an agent may serve while it is in restricted plain-HTTP mode (no
 * readable certificate). Everything else gets a 403, because over plain HTTP
 * the bearer-token auth is defeated by any network observer: a sniffer can read
 * and replay tokens, and deploy payloads carry resolved secret values. The
 * enrollment handshake carries no reusable credential, since the manager signs a
 * single-use nonce and the response is the public certificate. The private key
 * is generated on the agent and never leaves it.
 */
export const HTTP_ENROLLMENT_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/auth/verify',
  '/tls/challenge',
  '/tls/enroll',
]);

export function isAllowedOverPlainHttp(pathname: string): boolean {
  return HTTP_ENROLLMENT_ALLOWED_PATHS.has(pathname);
}

// Derived from the Set so the startup warning and the 403 error cannot drift
// from the actual allowlist when a path is added or renamed.
export const HTTP_ENROLLMENT_ALLOWED_PATHS_TEXT = [...HTTP_ENROLLMENT_ALLOWED_PATHS].join(', ');

/** A missing certificate must fall back to the restricted surface, since that is how the manager
 *  enrolls one. Only a half-configured path pair is fatal. */
export function resolveTlsStartup(
  certPath: string | undefined,
  keyPath: string | undefined,
  isReadable: (path: string) => boolean,
): TlsStartupDecision {
  if (!certPath && !keyPath) return { mode: 'http', restricted: false };
  if (!certPath || !keyPath) {
    return {
      mode: 'fatal',
      error:
        'Both TLS_CERT_PATH and TLS_KEY_PATH must be set together, and only one was provided. Set both on the agent service and restart it.',
    };
  }
  if (isReadable(certPath) && isReadable(keyPath)) return { mode: 'tls', certPath, keyPath };
  return {
    mode: 'http',
    restricted: true,
    warning:
      `TLS certificate or key is missing or unreadable: '${certPath}' / '${keyPath}'. Serving HTTP so the manager can enroll a certificate, with the API restricted to the enrollment endpoints until one is enrolled.`,
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

const CHALLENGE_TTL_MS = 60_000;
/** Issued nonces are not stored, so an unauthenticated caller cannot exhaust or evict a pending one. */
const challengeSecret = randomBytes(32);
const MAX_USED_NONCES = 256;
const usedNonces = new Map<string, number>();

/** The MAC binds the nonce to this process, and its timestamp bounds how long a capture is replayable. */
export function issueChallenge(now = Date.now()): { nonce: string; expiresAt: number } {
  const body = `${now}.${randomBytes(16).toString('hex')}`;
  const mac = createHmac('sha256', challengeSecret).update(body).digest('base64url');
  return { nonce: `${body}.${mac}`, expiresAt: now + CHALLENGE_TTL_MS };
}

export function isFreshChallenge(nonce: string, now = Date.now()): boolean {
  const parts = nonce.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtRaw, random, mac] = parts as [string, string, string];
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;
  const expected = createHmac('sha256', challengeSecret).update(`${issuedAtRaw}.${random}`).digest('base64url');
  const given = Buffer.from(mac);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return false;
  return now - issuedAt <= CHALLENGE_TTL_MS && issuedAt <= now + CHALLENGE_TTL_MS;
}

/** Recorded only after a signature verifies, so the map can only grow through legitimate enrollments. */
function recordUsedNonce(nonce: string, now = Date.now()): boolean {
  for (const [seen, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(seen);
  }
  if (usedNonces.has(nonce)) return false;
  while (usedNonces.size >= MAX_USED_NONCES) {
    const oldest = usedNonces.keys().next().value;
    if (oldest === undefined) break;
    usedNonces.delete(oldest);
  }
  usedNonces.set(nonce, now + CHALLENGE_TTL_MS);
  return true;
}

export function handleTlsChallenge(): Response {
  return Response.json(issueChallenge());
}

/** Both sides build this from the same three inputs, and each pins the exact string in a test so the two cannot drift. */
export function enrollmentPayload(nonce: string, hostName: string, sans: readonly string[]): string {
  return `${nonce}\n${hostName}\n${sans.join(',')}`;
}

interface EnrollmentProof {
  nonce: string;
  signature: string;
}

function parseEnrollmentProof(body: unknown): EnrollmentProof {
  const raw = body as { nonce?: unknown; signature?: unknown } | null;
  if (typeof raw?.nonce !== 'string' || raw.nonce.trim() === '') {
    throw new TlsEnrollError('The enroll request requires the nonce from a challenge');
  }
  if (typeof raw.signature !== 'string' || raw.signature.trim() === '') {
    throw new TlsEnrollError('The enroll request requires a signature over the challenge payload');
  }
  return { nonce: raw.nonce.trim(), signature: raw.signature.trim() };
}

// One enroll at a time: concurrent enrolls could otherwise rename a mismatched
// key and cert pair into place.
let enrollChain: Promise<unknown> = Promise.resolve();

/** Scheduled only once the files are in place, and must not throw: either would misreport a
 *  successful enrollment, as a raced restart or as a 500. */
export interface TlsEnrollOptions {
  stacksDir: string;
  trustedPublicKey: CryptoKey;
  hostName: string;
  spawnFn?: SpawnFn;
  scheduleRestart?: () => boolean;
}

export function handleTlsEnroll(request: Request, options: TlsEnrollOptions): Promise<Response> {
  const result = enrollChain.then(() => enroll(request, options));
  enrollChain = result.catch(() => undefined);
  return result;
}

async function enroll(request: Request, options: TlsEnrollOptions): Promise<Response> {
  const { stacksDir, trustedPublicKey, hostName, spawnFn = realSpawn, scheduleRestart } = options;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The enroll request requires a JSON body with a "sans" array' }, { status: 400 });
  }

  let sans: string[];
  let proof: EnrollmentProof;
  try {
    sans = parseAndValidateSans(body);
    proof = parseEnrollmentProof(body);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Invalid enroll request' }, { status: 400 });
  }

  if (!isFreshChallenge(proof.nonce)) {
    return Response.json({ error: 'The enrollment challenge is unknown or has expired.' }, { status: 401 });
  }
  // The submitted list is signed verbatim, before validation normalizes it.
  const submittedSans = (body as { sans: string[] }).sans;
  const payload = enrollmentPayload(proof.nonce, hostName, submittedSans);
  if (!(await verifyPayloadSignature(payload, proof.signature, trustedPublicKey))) {
    return Response.json(
      { error: `The enroll request signature does not verify for host '${hostName}'.` },
      { status: 401 },
    );
  }
  if (!recordUsedNonce(proof.nonce)) {
    return Response.json({ error: 'This enrollment request has already been used.' }, { status: 401 });
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
  } catch (err) {
    removeQuietly(stagedKeyPath);
    removeQuietly(stagedCertPath);
    return Response.json(
      { error: `Could not write the TLS key material: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // Scheduled only after the files are in place, so a restart can never race
  // the enrollment itself. The callback returning false (Docker unavailable)
  // is reported instead of swallowed: the manager uses it to tell a failed
  // provisioning apart from one that needs a manual restart.
  let selfRestartScheduled = false;
  if (scheduleRestart) {
    try {
      selfRestartScheduled = scheduleRestart();
    } catch (err) {
      console.error('Scheduling the post-enrollment self-restart failed:', err);
    }
  }
  return Response.json({ certPem, selfRestartScheduled });
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
