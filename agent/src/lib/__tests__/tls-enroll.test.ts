import { describe, it, expect, beforeAll } from 'bun:test';
import { generateKeyPair, exportJWK } from 'jose';
import { mkdirSync, mkdtempSync, readdirSync, statSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSubjectAltName,
  enrollmentPayload,
  handleTlsChallenge,
  handleTlsEnroll,
  HTTP_ENROLLMENT_ALLOWED_PATHS,
  HTTP_ENROLLMENT_ALLOWED_PATHS_TEXT,
  isAllowedOverPlainHttp,
  issueChallenge,
  parseAndValidateSans,
  resolveTlsStartup,
  TlsEnrollError,
  type SpawnFn,
  type TlsEnrollOptions,
} from '../tls-enroll';
import { AUTH_BYPASS_PATHS, authenticateRequest } from '../../middleware';
import { loadTrustedPublicKey } from '../jwt-auth';

interface SpawnCall {
  command: string;
  args: string[];
}

function fakeSpawn(outputs: { stdout?: string; stderr?: string; exitCode?: number }[]): {
  spawnFn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const queue = [...outputs];
  const spawnFn: SpawnFn = async (command, args) => {
    calls.push({ command, args });
    const next = queue.shift() ?? { exitCode: 0, stdout: '' };
    return { stdout: next.stdout ?? '', stderr: next.stderr ?? '', exitCode: next.exitCode ?? 0 };
  };
  return { spawnFn, calls };
}

const KEY_PEM = '[REDACTED PRIVATE KEY]\n';
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n';

// The agent's host name as the manager sees it: it is mixed into the signed
// payload, so a body signed for another host must not verify here.
const HOST_NAME = 'agent-1.lan';

let trustedPublicKey: CryptoKey;
let signPayload: (payload: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  trustedPublicKey = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    await exportJWK(privateKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  signPayload = async (payload) =>
    Buffer.from(await crypto.subtle.sign('Ed25519', signingKey, new TextEncoder().encode(payload))).toString('base64');
});

function enrollOptions(stacksDir: string, extra: Partial<TlsEnrollOptions> = {}): TlsEnrollOptions {
  return { stacksDir, trustedPublicKey, hostName: HOST_NAME, tlsConfigured: true, ...extra };
}

/**
 * Mints a fresh challenge and signs the payload the manager would sign. `signSans`
 * defaults to the submitted list, and passing a different list models a body whose
 * signature does not cover what was actually submitted.
 */
async function signedBody(
  sans: string[],
  signSans: string[] = sans,
  nonce: string = issueChallenge().nonce,
): Promise<{ sans: string[]; nonce: string; signature: string }> {
  return { sans, nonce, signature: await signPayload(enrollmentPayload(nonce, HOST_NAME, signSans)) };
}

function enrollRequest(body: unknown): Request {
  return new Request('http://localhost/tls/enroll', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function enrollRequestFor(sans: string[]): Promise<Request> {
  return enrollRequest(await signedBody(sans));
}

describe('tls-enroll', () => {
  describe('enrollmentPayload', () => {
    it('pins the nonce/host/sans format shared with the manager', () => {
      // The manager builds the same string in src/lib/crypto/agent-jwt.ts, and each
      // side pins it so the two cannot drift apart silently.
      // Same fixture as the manager's copy of this test, so a change on either
      // builder fails both suites instead of only failing at runtime.
      expect(enrollmentPayload('nonce-1', 'agent-1.lan', ['agent-1.lan', '10.0.0.5', 'localhost'])).toBe(
        'nonce-1\nagent-1.lan\nagent-1.lan,10.0.0.5,localhost',
      );
    });
  });

  describe('parseAndValidateSans', () => {
    it('accepts DNS names and IP literals and dedupes case-insensitively', () => {
      expect(parseAndValidateSans({ sans: ['myhost.lan', '192.168.1.10', 'MyHost.LAN'] })).toEqual([
        'myhost.lan',
        '192.168.1.10',
      ]);
    });

    it('rejects a missing or empty sans array', () => {
      expect(() => parseAndValidateSans({})).toThrow(TlsEnrollError);
      expect(() => parseAndValidateSans({ sans: [] })).toThrow(TlsEnrollError);
    });

    it('rejects non-string entries', () => {
      expect(() => parseAndValidateSans({ sans: [42] })).toThrow(/must be a string/);
    });

    it('rejects path traversal and metacharacters', () => {
      for (const bad of ['../etc/passwd', 'a/b', 'a b', 'a;b', 'a$b', '.']) {
        expect(() => parseAndValidateSans({ sans: [bad] })).toThrow(/Invalid SAN/);
      }
    });

    it('rejects empty DNS labels and labels with leading or trailing hyphens', () => {
      expect(() => parseAndValidateSans({ sans: ['a..b'] })).toThrow(/Invalid SAN/);
      expect(() => parseAndValidateSans({ sans: ['-bad.lan'] })).toThrow(/Invalid SAN/);
      expect(() => parseAndValidateSans({ sans: ['bad-.lan'] })).toThrow(/Invalid SAN/);
    });

    it('accepts a bracketed IPv6 literal and stores it bare', () => {
      expect(parseAndValidateSans({ sans: ['[::1]'] })).toEqual(['::1']);
      expect(parseAndValidateSans({ sans: ['[::1]', '::1'] })).toEqual(['::1']);
    });

    it('rejects an IP literal longer than the 45-character IPv6 text form', () => {
      const oversized = 'a'.repeat(44) + '::b';
      expect(oversized.length).toBeGreaterThan(45);
      expect(() => parseAndValidateSans({ sans: [oversized] })).toThrow(/at most 45 characters/);
    });
  });

  describe('buildSubjectAltName', () => {
    it('classifies IP literals and DNS names', () => {
      expect(buildSubjectAltName(['myhost.lan', '192.168.1.10', '::1'])).toBe(
        'DNS:myhost.lan,IP:192.168.1.10,IP:::1',
      );
    });

    it('strips brackets from a bracketed IPv6 literal', () => {
      expect(buildSubjectAltName(['[2001:db8::1]'])).toBe('IP:2001:db8::1');
    });
  });

  describe('handleTlsChallenge', () => {
    it('issues a nonce with a future expiry', async () => {
      const response = handleTlsChallenge(true);
      const body = (await response.json()) as { nonce: string; expiresAt: number };
      expect(typeof body.nonce).toBe('string');
      expect(body.nonce.length).toBeGreaterThan(0);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('reports whether this agent can serve TLS at all', async () => {
      expect(((await handleTlsChallenge(true).json()) as { tlsConfigured: boolean }).tlsConfigured).toBe(true);
      expect(((await handleTlsChallenge(false).json()) as { tlsConfigured: boolean }).tlsConfigured).toBe(false);
    });
  });

  describe('handleTlsEnroll', () => {
    it('generates the key, signs the cert with the requested SANs, writes both files mode 0600, and returns the cert PEM', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn, calls } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        const response = await handleTlsEnroll(
          await enrollRequestFor(['myhost.lan', '192.168.1.10']),
          enrollOptions(dir, { spawnFn }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { certPem: string };
        expect(body.certPem).toBe(CERT_PEM);

        expect(calls[0].command).toBe('openssl');
        expect(calls[0].args).toContain('rsa_keygen_bits:2048');
        expect(calls[1].command).toBe('openssl');
        expect(calls[1].args).toContain('/CN=hlm-agent-tls');
        const sanIndex = calls[1].args.indexOf('subjectAltName=DNS:myhost.lan,IP:192.168.1.10');
        expect(sanIndex).toBeGreaterThan(-1);
        expect(calls[1].args[calls[1].args.indexOf('-days') + 1]).toBe('3650');

        const certPath = join(dir, 'hlm-agent-tls', 'cert.pem');
        const keyPath = join(dir, 'hlm-agent-tls', 'key.pem');
        expect(statSync(certPath).mode & 0o777).toBe(0o600);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(certPath, 'utf8')).toBe(CERT_PEM);
        expect(readFileSync(keyPath, 'utf8')).toBe(KEY_PEM);
        // Enrollment writes exactly the pair: no marker file, no staging leftovers.
        expect(readdirSync(join(dir, 'hlm-agent-tls')).sort()).toEqual(['cert.pem', 'key.pem']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports a scheduled self-restart in the enroll response', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        let restartCalls = 0;
        const response = await handleTlsEnroll(
          await enrollRequestFor(['myhost.lan']),
          enrollOptions(dir, {
            spawnFn,
            scheduleRestart: () => {
              restartCalls += 1;
              return true;
            },
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { certPem: string; selfRestartScheduled: boolean };
        expect(body.certPem).toBe(CERT_PEM);
        expect(body.selfRestartScheduled).toBe(true);
        // Scheduled only after the cert and key are in place.
        expect(restartCalls).toBe(1);
        expect(readdirSync(join(dir, 'hlm-agent-tls')).sort()).toEqual(['cert.pem', 'key.pem']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports selfRestartScheduled false when no restart callback is wired', async () => {
      // TLS-mode agents (cert rotation) get no callback: the manager drives
      // the restart over the existing HTTPS channel.
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        const response = await handleTlsEnroll(await enrollRequestFor(['myhost.lan']), enrollOptions(dir, { spawnFn }));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { selfRestartScheduled: boolean };
        expect(body.selfRestartScheduled).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not schedule a restart when the enrollment fails', async () => {
      const { spawnFn } = fakeSpawn([{ stderr: 'openssl exploded', exitCode: 1 }]);
      let restartCalls = 0;
      const response = await handleTlsEnroll(
        await enrollRequestFor(['myhost.lan']),
        enrollOptions('/tmp', {
          spawnFn,
          scheduleRestart: () => {
            restartCalls += 1;
            return true;
          },
        }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { selfRestartScheduled?: boolean };
      expect(body.selfRestartScheduled).toBeUndefined();
      expect(restartCalls).toBe(0);
    });

    it('still returns the certificate when the restart callback throws', async () => {
      // A throwing callback must not turn a completed enrollment into a 500:
      // the cert and key are already in place, and the manager can still poll.
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        const response = await handleTlsEnroll(
          await enrollRequestFor(['myhost.lan']),
          enrollOptions(dir, {
            spawnFn,
            scheduleRestart: () => {
              throw new Error('docker unavailable');
            },
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { certPem: string; selfRestartScheduled: boolean };
        expect(body.certPem).toBe(CERT_PEM);
        expect(body.selfRestartScheduled).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns 400 for a malformed JSON body', async () => {
      const request = new Request('http://localhost/tls/enroll', { method: 'POST', body: 'not json' });
      const response = await handleTlsEnroll(request, enrollOptions('/tmp'));
      expect(response.status).toBe(400);
    });

    it('generates a real certificate through the default openssl spawn', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const response = await handleTlsEnroll(
          await enrollRequestFor(['myhost.lan', '192.168.1.10']),
          enrollOptions(dir),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { certPem: string };
        expect(body.certPem).toContain('BEGIN CERTIFICATE');
        expect(body.certPem).toContain('END CERTIFICATE');
        expect(statSync(join(dir, 'hlm-agent-tls', 'key.pem')).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20000);

    it('caps the SAN list at 32 entries', async () => {
      const { spawnFn, calls } = fakeSpawn([]);
      const response = await handleTlsEnroll(
        enrollRequest({ sans: Array.from({ length: 33 }, (_, i) => `host${i}.lan`) }),
        enrollOptions('/tmp', { spawnFn }),
      );
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('returns 500 without writing files when key generation fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stderr: 'keygen broke', exitCode: 1 }]);
        const response = await handleTlsEnroll(await enrollRequestFor(['myhost.lan']), enrollOptions(dir, { spawnFn }));
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain('Could not generate the TLS private key');
        expect(existsSync(join(dir, 'hlm-agent-tls'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns 400 without spawning openssl when a SAN fails validation', async () => {
      const { spawnFn, calls } = fakeSpawn([]);
      const response = await handleTlsEnroll(enrollRequest({ sans: ['../escape'] }), enrollOptions('/tmp', { spawnFn }));
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Invalid SAN');
    });

    it('leaves the previous key and cert pair consistent when an enroll is interrupted at signing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const tlsDir = join(dir, 'hlm-agent-tls');
        mkdirSync(tlsDir, { recursive: true });
        const previousKey = 'previous key\n';
        const previousCert = 'previous cert\n';
        writeFileSync(join(tlsDir, 'key.pem'), previousKey);
        writeFileSync(join(tlsDir, 'cert.pem'), previousCert);

        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stderr: 'signing broke', exitCode: 1 }]);
        const response = await handleTlsEnroll(await enrollRequestFor(['myhost.lan']), enrollOptions(dir, { spawnFn }));
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain('TLS certificate signing failed');
        expect(readFileSync(join(tlsDir, 'key.pem'), 'utf8')).toBe(previousKey);
        expect(readFileSync(join(tlsDir, 'cert.pem'), 'utf8')).toBe(previousCert);
        const leftovers = readdirSync(tlsDir).filter((name) => name.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('serializes concurrent enrolls so the final pair comes from one enroll', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const CERT_A = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n';
        const CERT_B = '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n';
        const { spawnFn, calls } = fakeSpawn([
          { stdout: KEY_PEM }, { stdout: CERT_A }, { stdout: KEY_PEM }, { stdout: CERT_B },
        ]);
        const [first, second] = await Promise.all([
          handleTlsEnroll(await enrollRequestFor(['a.lan']), enrollOptions(dir, { spawnFn })),
          handleTlsEnroll(await enrollRequestFor(['b.lan']), enrollOptions(dir, { spawnFn })),
        ]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        // Signing reads the staged key before any rename, so a serialized run
        // is keygen, sign, keygen, sign with no interleave.
        const signingCalls = calls.map((c) => c.args[0]);
        expect(signingCalls).toEqual(['genpkey', 'req', 'genpkey', 'req']);

        const tlsDir = join(dir, 'hlm-agent-tls');
        const key = readFileSync(join(tlsDir, 'key.pem'), 'utf8');
        const cert = readFileSync(join(tlsDir, 'cert.pem'), 'utf8');
        expect(await second.json()).toEqual({ certPem: cert, selfRestartScheduled: false });
        expect(key.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('handleTlsEnroll enrollment proof', () => {
    it('refuses to enroll when this agent has no TLS configured', async () => {
      const body = await signedBody(['myhost.lan']);
      const response = await handleTlsEnroll(
        enrollRequest(body),
        enrollOptions('/tmp', { tlsConfigured: false }),
      );
      expect(response.status).toBe(409);
      const json = (await response.json()) as { error: string };
      expect(json.error).toContain('no TLS configured');
    });

    it('returns 400 when the nonce and signature are missing', async () => {
      const missing = await handleTlsEnroll(enrollRequest({ sans: ['myhost.lan'] }), enrollOptions('/tmp'));
      expect(missing.status).toBe(400);

      const blank = await handleTlsEnroll(
        enrollRequest({ sans: ['myhost.lan'], nonce: '', signature: '' }),
        enrollOptions('/tmp'),
      );
      expect(blank.status).toBe(400);
      const body = (await blank.json()) as { error: string };
      expect(body.error).toContain('nonce');
    });

    it('returns 401 when the signature covers a different sans list than the one submitted', async () => {
      const response = await handleTlsEnroll(
        enrollRequest(await signedBody(['submitted.lan'], ['other.lan'])),
        enrollOptions('/tmp'),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('does not verify');
    });

    it('returns 401 for a garbage signature', async () => {
      const sans = ['myhost.lan'];
      const nonce = issueChallenge().nonce;
      // Valid base64 of the right length, but not a signature over the payload.
      const response = await handleTlsEnroll(
        enrollRequest({ sans, nonce, signature: Buffer.alloc(64).toString('base64') }),
        enrollOptions('/tmp'),
      );
      expect(response.status).toBe(401);
    });

    it('returns 401 for a nonce this agent never issued', async () => {
      const sans = ['myhost.lan'];
      const nonce = 'a'.repeat(32);
      const response = await handleTlsEnroll(
        enrollRequest({ sans, nonce, signature: await signPayload(enrollmentPayload(nonce, HOST_NAME, sans)) }),
        enrollOptions('/tmp'),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('unknown or has expired');
    });

    it('returns 401 when the challenge has expired', async () => {
      const sans = ['myhost.lan'];
      // Minted a minute and a second ago, so its 60s TTL is already past.
      const { nonce } = issueChallenge(Date.now() - 61_000);
      const response = await handleTlsEnroll(
        enrollRequest({ sans, nonce, signature: await signPayload(enrollmentPayload(nonce, HOST_NAME, sans)) }),
        enrollOptions('/tmp'),
      );
      expect(response.status).toBe(401);
    });

    it('rejects a replayed body because the nonce is single-use', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        const body = await signedBody(['myhost.lan']);

        const first = await handleTlsEnroll(enrollRequest(body), enrollOptions(dir, { spawnFn }));
        expect(first.status).toBe(200);

        const replay = await handleTlsEnroll(enrollRequest(body), enrollOptions(dir, { spawnFn }));
        expect(replay.status).toBe(401);
        const replayBody = (await replay.json()) as { error: string };
        expect(replayBody.error).toContain('already been used');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records a nonce as used only once its signature verifies', async () => {
      // Only verified enrollments grow the used set, which is what stops an
      // unauthenticated caller from filling it to block a real enrollment.
      const sans = ['myhost.lan'];
      const nonce = issueChallenge().nonce;

      const forged = await handleTlsEnroll(
        enrollRequest({ sans, nonce, signature: await signPayload(enrollmentPayload(nonce, HOST_NAME, ['other.lan'])) }),
        enrollOptions('/tmp'),
      );
      expect(forged.status).toBe(401);

      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        const retry = await handleTlsEnroll(
          enrollRequest({ sans, nonce, signature: await signPayload(enrollmentPayload(nonce, HOST_NAME, sans)) }),
          enrollOptions(dir, { spawnFn }),
        );
        expect(retry.status).toBe(200);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveTlsStartup', () => {
    const allReadable = () => true;
    const nothingReadable = () => false;

    it('serves TLS when both files are readable', () => {
      expect(resolveTlsStartup('/c.pem', '/k.pem', allReadable)).toEqual({
        mode: 'tls',
        certPath: '/c.pem',
        keyPath: '/k.pem',
      });
    });

    it('serves plain HTTP without a warning when TLS is not configured', () => {
      expect(resolveTlsStartup(undefined, undefined, allReadable)).toEqual({ mode: 'http', restricted: false });
    });

    it('is fatal when only one path is set', () => {
      // Misconfiguration, not a recoverable state: enrollment writes to the
      // canonical paths under STACKS_DIR, which is not the path that is wrong here.
      expect(resolveTlsStartup('/c.pem', undefined, allReadable).mode).toBe('fatal');
      expect(resolveTlsStartup(undefined, '/k.pem', allReadable).mode).toBe('fatal');
    });

    it('falls back to restricted plain HTTP, naming the paths, when the certificate is unreadable', () => {
      // There is no marker file: a host whose certificates were removed is
      // treated like a first boot, so the manager can re-enroll it.
      const decision = resolveTlsStartup('/c.pem', '/k.pem', nothingReadable);
      expect(decision.mode).toBe('http');
      if (decision.mode === 'http') {
        expect(decision.restricted).toBe(true);
        expect(decision.warning).toContain("'/c.pem' / '/k.pem'");
        expect(decision.warning).toContain('enroll');
      }
    });

    it('falls back to restricted plain HTTP when only the key is unreadable', () => {
      const decision = resolveTlsStartup('/c.pem', '/k.pem', (path) => path === '/c.pem');
      expect(decision.mode).toBe('http');
      if (decision.mode === 'http') expect(decision.restricted).toBe(true);
    });

    it('allows only the enrollment endpoints over restricted plain HTTP', () => {
      // The enrollment handshake must stay reachable without TLS or a first
      // boot could never provision a certificate.
      expect(isAllowedOverPlainHttp('/health')).toBe(true);
      expect(isAllowedOverPlainHttp('/auth/verify')).toBe(true);
      expect(isAllowedOverPlainHttp('/tls/challenge')).toBe(true);
      expect(isAllowedOverPlainHttp('/tls/enroll')).toBe(true);

      // The derived-text test pins the Set's exact contents, so these guard
      // only the matching shape: exact pathname, never a prefix.
      expect(isAllowedOverPlainHttp('/')).toBe(false);
      expect(isAllowedOverPlainHttp('/tls/enroll/')).toBe(false);
      expect(isAllowedOverPlainHttp('/health/x')).toBe(false);
    });

    it('keeps every JWT-bypassed path inside the plain-HTTP allowlist', () => {
      // authenticateRequest skips JWT for AUTH_BYPASS_PATHS, so a path dropped from
      // the allowlist would be 403ed in restricted mode.
      for (const path of AUTH_BYPASS_PATHS) {
        expect(HTTP_ENROLLMENT_ALLOWED_PATHS.has(path)).toBe(true);
      }
      expect(HTTP_ENROLLMENT_ALLOWED_PATHS_TEXT).toBe('/health, /auth/verify, /tls/challenge, /tls/enroll');
    });
  });

  describe('JWT enforcement', () => {
    it('bypasses JWT for /tls/enroll while a non-bypassed path still requires a token', async () => {
      // Enrollment is no longer JWT-gated: it authorizes itself with a signature
      // over a single-use nonce, which is the only thing that can work over plain HTTP.
      expect(AUTH_BYPASS_PATHS.has('/tls/enroll')).toBe(true);

      const bypassed = await authenticateRequest(new Headers(), trustedPublicKey, '/tls/enroll', HOST_NAME);
      expect(bypassed).toBeNull();

      const gated = await authenticateRequest(new Headers(), trustedPublicKey, '/stats', HOST_NAME);
      expect(gated?.status).toBe(401);
    });
  });
});
