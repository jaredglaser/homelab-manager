import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  AnsibleDisabledError,
  isAnsibleEnabled,
  loadAnsibleConfig,
} from '@/lib/config/ansible-config';

const KEYS = [
  'ANSIBLE_RUNNER_ENABLED',
  'ANSIBLE_SIDECAR_URL',
  'ANSIBLE_SIDECAR_TOKEN',
  'ANSIBLE_REMOTE_USER',
  'ANSIBLE_APPDATA_ROOT',
  'ANSIBLE_SELF_HOST_NAME',
] as const;

describe('ansible-config', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('is off unless the flag is exactly "true"', () => {
    expect(isAnsibleEnabled()).toBe(false);
    process.env.ANSIBLE_RUNNER_ENABLED = 'yes';
    expect(isAnsibleEnabled()).toBe(false);
    process.env.ANSIBLE_RUNNER_ENABLED = 'true';
    expect(isAnsibleEnabled()).toBe(true);
  });

  it('throws AnsibleDisabledError when the flag is off', () => {
    expect(() => loadAnsibleConfig()).toThrow(AnsibleDisabledError);
    expect(new AnsibleDisabledError().status).toBe(503);
  });

  it('throws when enabled without a sidecar token, rather than dispatching into nothing', () => {
    process.env.ANSIBLE_RUNNER_ENABLED = 'true';
    expect(() => loadAnsibleConfig()).toThrow();
  });

  it('falls back to defaults for everything but the token', () => {
    process.env.ANSIBLE_RUNNER_ENABLED = 'true';
    process.env.ANSIBLE_SIDECAR_TOKEN = 'tok';

    expect(loadAnsibleConfig()).toEqual({
      enabled: true,
      sidecarUrl: 'http://ansible-sidecar:9095',
      sidecarToken: 'tok',
      remoteUser: 'ansible',
      appdataRoot: '/srv/appdata',
      selfHostName: null,
    });
  });

  it('reads every override from the environment', () => {
    process.env.ANSIBLE_RUNNER_ENABLED = 'true';
    process.env.ANSIBLE_SIDECAR_TOKEN = 'tok';
    process.env.ANSIBLE_SIDECAR_URL = 'https://sidecar.example:9095';
    process.env.ANSIBLE_REMOTE_USER = 'automation';
    process.env.ANSIBLE_APPDATA_ROOT = '/data/appdata';
    process.env.ANSIBLE_SELF_HOST_NAME = 'host-a';

    expect(loadAnsibleConfig()).toMatchObject({
      sidecarUrl: 'https://sidecar.example:9095',
      remoteUser: 'automation',
      appdataRoot: '/data/appdata',
      selfHostName: 'host-a',
    });
  });

  it('rejects a sidecar URL that is not a URL', () => {
    process.env.ANSIBLE_RUNNER_ENABLED = 'true';
    process.env.ANSIBLE_SIDECAR_TOKEN = 'tok';
    process.env.ANSIBLE_SIDECAR_URL = 'sidecar:9095';
    expect(() => loadAnsibleConfig()).toThrow();
  });
});
