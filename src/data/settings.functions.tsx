import { createServerFn } from '@tanstack/react-start';
import { settingsSchema } from '@/lib/validation/settings-schemas';
import type { Settings } from '@/lib/validation/settings-schemas';
import type { SettingsSaved } from '@/types/settings';

/**
 * In-memory settings store.
 * In a production app this would be backed by a database or config file.
 * For now, settings default from environment variables and can be overridden at runtime.
 */
let savedSettings: Settings | null = null;

function getDefaults(): Settings {
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
      password: process.env.ZFS_SSH_PASSWORD || '',
      keyPath: process.env.ZFS_SSH_KEY_PATH || '',
      passphrase: process.env.ZFS_SSH_KEY_PASSPHRASE || '',
    },
  };
}

function stripSecrets(settings: Settings): SettingsSaved {
  return {
    docker: {
      host: settings.docker.host,
      port: settings.docker.port,
      protocol: settings.docker.protocol,
    },
    zfs: {
      host: settings.zfs.host,
      port: settings.zfs.port,
      username: settings.zfs.username,
      authType: settings.zfs.authType,
      hasPassword: !!(settings.zfs.password && settings.zfs.password.length > 0),
      keyPath: settings.zfs.keyPath || undefined,
      hasPassphrase: !!(settings.zfs.passphrase && settings.zfs.passphrase.length > 0),
    },
  };
}

/**
 * Load current settings (secrets stripped).
 */
export const getSettings = createServerFn().handler(async (): Promise<SettingsSaved> => {
  const current = savedSettings ?? getDefaults();
  return stripSecrets(current);
});

/**
 * Save settings after validation.
 */
export const saveSettings = createServerFn()
  .validator(settingsSchema)
  .handler(async ({ data }): Promise<SettingsSaved> => {
    savedSettings = data;
    return stripSecrets(data);
  });
