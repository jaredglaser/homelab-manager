import { describe, it, expect } from 'bun:test';
import { generateKeyPair, exportJWK } from 'jose';
import { mkdtempSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSubjectAltName,
  handleTlsEnroll,
  parseAndValidateSans,
  parseTlsHttpFallback,
  resolveTlsStartup,
  TlsEnrollError,
  type SpawnFn,
} from '../tls-enroll';
import { authenticateRequest } from '../../middleware';
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

const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nFAKEKEY\n-----END PRIVATE KEY-----\n';
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n';

function enrollRequest(sans: string[]): Request {
  return new Request('http://localhost/tls/enroll', {
    method: 'POST',
    body: JSON.stringify({ sans }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('tls-enroll', () => {
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
  });

  describe('buildSubjectAltName', () => {
    it('classifies IP literals and DNS names', () => {
      expect(buildSubjectAltName(['myhost.lan', '192.168.1.10', '::1'])).toBe(
        'DNS:myhost.lan,IP:192.168.1.10,IP:::1',
      );
    });
  });

  describe('handleTlsEnroll', () => {
    it('generates the key, signs the cert with the requested SANs, writes both files mode 0600, and returns the cert PEM', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn, calls } = fakeSpawn([{ stdout: KEY_PEM }, { stdout: CERT_PEM }]);
        const response = await handleTlsEnroll(enrollRequest(['myhost.lan', '192.168.1.10']), dir, spawnFn);
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
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns 400 for a malformed JSON body', async () => {
      const request = new Request('http://localhost/tls/enroll', { method: 'POST', body: 'not json' });
      const response = await handleTlsEnroll(request, '/tmp', async () => ({ stdout: '', stderr: '', exitCode: 0 }));
      expect(response.status).toBe(400);
    });

    it('returns 400 without spawning openssl when a SAN fails validation', async () => {
      const { spawnFn, calls } = fakeSpawn([]);
      const response = await handleTlsEnroll(enrollRequest(['../escape']), '/tmp', spawnFn);
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Invalid SAN');
    });

    it('removes the staged key and returns 500 when signing fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hlm-enroll-'));
      try {
        const { spawnFn } = fakeSpawn([{ stdout: KEY_PEM }, { stderr: 'signing broke', exitCode: 1 }]);
        const response = await handleTlsEnroll(enrollRequest(['myhost.lan']), dir, spawnFn);
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain('TLS certificate signing failed');
        expect(existsSync(join(dir, 'hlm-agent-tls', 'key.pem'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('parseTlsHttpFallback', () => {
    it('accepts true, false, and undefined', () => {
      expect(parseTlsHttpFallback(undefined)).toBe(false);
      expect(parseTlsHttpFallback('true')).toBe(true);
      expect(parseTlsHttpFallback('false')).toBe(false);
    });

    it('rejects malformed values', () => {
      for (const bad of ['TRUE', '1', 'yes', '']) {
        expect(() => parseTlsHttpFallback(bad)).toThrow(/Invalid HLM_TLS_HTTP_FALLBACK/);
      }
    });
  });

  describe('resolveTlsStartup', () => {
    const readable = () => true;
    const unreadable = () => false;

    it('serves TLS when both files are readable', () => {
      expect(resolveTlsStartup('/c.pem', '/k.pem', false, readable)).toEqual({
        mode: 'tls',
        certPath: '/c.pem',
        keyPath: '/k.pem',
      });
    });

    it('serves plain HTTP without a warning when TLS is not configured', () => {
      expect(resolveTlsStartup(undefined, undefined, false, readable)).toEqual({ mode: 'http' });
    });

    it('is fatal when only one path is set', () => {
      expect(resolveTlsStartup('/c.pem', undefined, false, readable).mode).toBe('fatal');
      expect(resolveTlsStartup(undefined, '/k.pem', true, readable).mode).toBe('fatal');
    });

    it('refuses to start when the cert is missing and no fallback is set', () => {
      const decision = resolveTlsStartup('/c.pem', '/k.pem', false, unreadable);
      expect(decision.mode).toBe('fatal');
      if (decision.mode === 'fatal') {
        expect(decision.error).toContain('HLM_TLS_HTTP_FALLBACK=true');
        expect(decision.error).toContain('/c.pem');
      }
    });

    it('is fatal when only the key is unreadable', () => {
      const decision = resolveTlsStartup('/c.pem', '/k.pem', false, (p) => p === '/c.pem');
      expect(decision.mode).toBe('fatal');
    });

    it('serves HTTP with a loud warning when the fallback opt-in is set', () => {
      const decision = resolveTlsStartup('/c.pem', '/k.pem', true, unreadable);
      expect(decision.mode).toBe('http');
      if (decision.mode === 'http') {
        expect(decision.warning).toContain('HLM_TLS_HTTP_FALLBACK=true');
        expect(decision.warning).toContain('without TLS');
      }
    });
  });

  describe('JWT enforcement', () => {
    it('rejects an unauthenticated request to /tls/enroll', async () => {
      const { publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
      const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
      const rejection = await authenticateRequest(new Headers(), trusted, '/tls/enroll', 'myhost');
      expect(rejection).not.toBeNull();
      expect(rejection?.status).toBe(401);
    });
  });
});
