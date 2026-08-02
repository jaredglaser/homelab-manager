import { z } from 'zod';

const AnsibleConfigSchema = z.object({
  enabled: z.boolean(),
  // z.url() alone accepts any scheme, so `sidecar:9095` would parse as a URL.
  sidecarUrl: z.url({ protocol: /^https?$/ }),
  sidecarToken: z.string().min(1),
  remoteUser: z.string().min(1),
  appdataRoot: z.string().min(1),
  selfHostName: z.string().nullable(),
});

export type AnsibleConfig = z.infer<typeof AnsibleConfigSchema>;

export class AnsibleDisabledError extends Error {
  public readonly status = 503;

  constructor() {
    super('Ansible execution is disabled. Set ANSIBLE_RUNNER_ENABLED=true to enable it.');
    this.name = 'AnsibleDisabledError';
  }
}

export function isAnsibleEnabled(): boolean {
  return process.env.ANSIBLE_RUNNER_ENABLED === 'true';
}

/**
 * Throws when the flag is on but the sidecar is not configured, so a half-enabled
 * deployment fails at the first request instead of dispatching runs into nothing.
 */
export function loadAnsibleConfig(): AnsibleConfig {
  if (!isAnsibleEnabled()) throw new AnsibleDisabledError();

  return AnsibleConfigSchema.parse({
    enabled: true,
    sidecarUrl: process.env.ANSIBLE_SIDECAR_URL || 'http://ansible-sidecar:9095',
    sidecarToken: process.env.ANSIBLE_SIDECAR_TOKEN ?? '',
    remoteUser: process.env.ANSIBLE_REMOTE_USER || 'ansible',
    appdataRoot: process.env.ANSIBLE_APPDATA_ROOT || '/srv/appdata',
    selfHostName: process.env.ANSIBLE_SELF_HOST_NAME || null,
  });
}
