import { describe, it, expect, mock, test } from 'bun:test';
import { generateTlsCert, type TlsCertRequest } from '../agent-tls-cert-generator';

interface SpawnCall {
  command: string;
  args: string[];
}

function makeSpawnQueue(steps: Array<{ exitCode: number; stdout?: string; stderr?: string }>) {
  const calls: SpawnCall[] = [];
  const spawnFn = mock((command: string, args: string[]) => {
    const step = steps[calls.length] ?? { exitCode: 0 };
    calls.push({ command, args });
    return Promise.resolve({ stdout: step.stdout ?? '', stderr: step.stderr ?? '', exitCode: step.exitCode });
  });
  return { spawnFn, calls };
}

const request: TlsCertRequest = { hostname: 'myhost.lan', ip: '192.168.1.10' };

describe('generateTlsCert', () => {
  it('generates the key first, then signs the cert with the staged key file', async () => {
    const { spawnFn, calls } = makeSpawnQueue([
      { exitCode: 0, stdout: 'KEY-PEM' },
      { exitCode: 0, stdout: 'CERT-PEM' },
    ]);
    const result = await generateTlsCert(request, spawnFn);
    expect(result).toEqual({ certPem: 'CERT-PEM', keyPem: 'KEY-PEM' });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe('openssl');
    expect(calls[0].args).toEqual(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048']);
    expect(calls[1].args).toContain('-x509');
    expect(calls[1].args[calls[1].args.indexOf('-days') + 1]).toBe('3650');
  });

  it('passes the generated key to the signing call through a 0600 temp file that is removed afterwards', async () => {
    const seenKeyPaths: string[] = [];
    const { spawnFn } = makeSpawnQueue([
      { exitCode: 0, stdout: 'KEY-PEM' },
      { exitCode: 0, stdout: 'CERT-PEM' },
    ]);
    const origSpawnFn = spawnFn;
    const inspectingSpawnFn = async (command: string, args: string[]) => {
      const keyIndex = args.indexOf('-key');
      if (keyIndex !== -1) {
        const path = args[keyIndex + 1];
        seenKeyPaths.push(path);
        const file = Bun.file(path);
        expect(await file.text()).toBe('KEY-PEM');
        const stat = await file.stat();
        expect(stat.mode & 0o777).toBe(0o600);
      }
      return origSpawnFn(command, args);
    };
    const result = await generateTlsCert(request, inspectingSpawnFn);
    expect(result.keyPem).toBe('KEY-PEM');
    expect(seenKeyPaths).toHaveLength(1);
    expect(await Bun.file(seenKeyPaths[0]).exists()).toBe(false);
  });

  it('covers the hostname, its IP, and the internal agent name in the SAN', async () => {
    const { spawnFn, calls } = makeSpawnQueue([
      { exitCode: 0, stdout: 'KEY-PEM' },
      { exitCode: 0, stdout: 'CERT-PEM' },
    ]);
    await generateTlsCert({ ...request, extraDnsNames: ['hlm-agent'] }, spawnFn);
    const san = calls[1].args[calls[1].args.indexOf('-addext') + 1];
    expect(san).toBe('subjectAltName=DNS:myhost.lan,IP:192.168.1.10,DNS:hlm-agent');
  });

  it('uses an IP SAN when the hostname is an IP literal and skips the duplicate IP entry', async () => {
    const { spawnFn, calls } = makeSpawnQueue([
      { exitCode: 0, stdout: 'KEY-PEM' },
      { exitCode: 0, stdout: 'CERT-PEM' },
    ]);
    await generateTlsCert({ hostname: '192.168.1.10', ip: '192.168.1.10', extraDnsNames: ['hlm-agent'] }, spawnFn);
    const san = calls[1].args[calls[1].args.indexOf('-addext') + 1];
    expect(san).toBe('subjectAltName=IP:192.168.1.10,DNS:hlm-agent');
  });

  it('does not duplicate an extra DNS name already covered by the hostname', async () => {
    const { spawnFn, calls } = makeSpawnQueue([
      { exitCode: 0, stdout: 'KEY-PEM' },
      { exitCode: 0, stdout: 'CERT-PEM' },
    ]);
    await generateTlsCert({ hostname: 'myhost.lan', extraDnsNames: ['MYHOST.LAN', 'other.lan'] }, spawnFn);
    const san = calls[1].args[calls[1].args.indexOf('-addext') + 1];
    expect(san).toBe('subjectAltName=DNS:myhost.lan,DNS:other.lan');
  });

  it('removes the staged key file even when the signing call fails', async () => {
    const keyPaths: string[] = [];
    const { spawnFn } = makeSpawnQueue([
      { exitCode: 0, stdout: 'KEY-PEM' },
      { exitCode: 1, stderr: 'Sign failing reason\n' },
    ]);
    const inspectingSpawnFn = async (command: string, args: string[]) => {
      const keyIndex = args.indexOf('-key');
      if (keyIndex !== -1) keyPaths.push(args[keyIndex + 1]);
      return spawnFn(command, args);
    };
    await expect(generateTlsCert(request, inspectingSpawnFn)).rejects.toThrow(
      'TLS certificate certificate signing failed: Sign failing reason',
    );
    expect(await Bun.file(keyPaths[0]).exists()).toBe(false);
  });

  it('throws with the openssl stderr detail when key generation fails', async () => {
    const { spawnFn } = makeSpawnQueue([
      { exitCode: 1, stderr: 'Error: bad key options\n' },
    ]);
    await expect(generateTlsCert(request, spawnFn)).rejects.toThrow(
      'TLS certificate private key generation failed: Error: bad key options',
    );
  });

  it('falls back to the exit code when stderr is empty', async () => {
    const { spawnFn } = makeSpawnQueue([{ exitCode: 2 }]);
    await expect(generateTlsCert(request, spawnFn)).rejects.toThrow(
      'TLS certificate private key generation failed: openssl exited 2',
    );
  });

  it('generates a verifiable cert pair with the real openssl binary', async () => {
    const { spawnSync } = await import('node:child_process');
    const available = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
    test.skipIf(!available);
    const result = await generateTlsCert({ hostname: 'probe.lan', ip: '10.0.0.1', extraDnsNames: ['hlm-agent'] });
    expect(result.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(result.certPem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    const inspect = spawnSync('openssl', ['x509', '-noout', '-ext', 'subjectAltName'], {
      input: result.certPem,
      encoding: 'utf8',
    });
    expect(inspect.stdout).toContain('DNS:probe.lan');
    expect(inspect.stdout).toContain('IP Address:10.0.0.1');
    expect(inspect.stdout).toContain('DNS:hlm-agent');
  }, 30000);
});
