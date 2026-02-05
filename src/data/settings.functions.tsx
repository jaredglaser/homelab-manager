import { createServerFn } from '@tanstack/react-start';
import { settingsSchema } from '@/lib/validation/settings-schemas';
import type { Settings } from '@/lib/validation/settings-schemas';
import type { SettingsSaved } from '@/types/settings';

/**
 * In-memory settings store.
 * In a production app this would be backed by a database or config file.
 * Secrets only exist here after an explicit save — the load path never
 * materializes passwords or passphrases.
 */
let savedSettings: Settings | null = null;

/**
 * Build the client-safe representation directly, without ever
 * constructing an object that contains secret values.
 */
function loadSettings(): SettingsSaved {
  if (savedSettings) {
    return {
      docker: {
        host: savedSettings.docker.host,
        port: savedSettings.docker.port,
        protocol: savedSettings.docker.protocol,
      },
      zfs: {
        host: savedSettings.zfs.host,
        port: savedSettings.zfs.port,
        username: savedSettings.zfs.username,
        authType: savedSettings.zfs.authType,
        hasPassword: !!(savedSettings.zfs.password && savedSettings.zfs.password.length > 0),
        keyPath: savedSettings.zfs.keyPath || undefined,
        hasPassphrase: !!(savedSettings.zfs.passphrase && savedSettings.zfs.passphrase.length > 0),
      },
    };
  }

  return {
    docker: {
      host: process.env.DOCKER_HOST_1 || '',
      port: parseInt(process.env.DOCKER_HOST_PORT_1 || '2375', 10),
      protocol: (process.env.DOCKER_PROTOCOL as 'http' | 'https') || 'http',
    },
    zfs: {
      host: process.env.ZFS_SSH_HOST || '',
      port: parseInt(process.env.ZFS_SSH_PORT || '22', 10),
      username: process.env.ZFS_SSH_USER || 'root',
      authType: process.env.ZFS_SSH_KEY_PATH ? 'privateKey' : 'password',
      hasPassword: !!process.env.ZFS_SSH_PASSWORD,
      keyPath: process.env.ZFS_SSH_KEY_PATH || undefined,
      hasPassphrase: !!process.env.ZFS_SSH_KEY_PASSPHRASE,
    },
  };
}

/**
 * Load current settings. Secrets are never included in the response.
 */
export const getSettings = createServerFn().handler(async (): Promise<SettingsSaved> => {
  return loadSettings();
});

/**
 * Save settings after validation.
 */
export const saveSettings = createServerFn()
  .validator(settingsSchema)
  .handler(async ({ data }): Promise<SettingsSaved> => {
    savedSettings = data;
    return loadSettings();
  });
