export type { DockerSettings, ZFSSettings, Settings } from '@/lib/validation/settings-schemas';

/**
 * Represents saved settings state returned to the client.
 * Sensitive fields (passwords, passphrases) are stripped and replaced
 * with a boolean indicating whether they have been configured.
 */
export interface DockerSettingsSaved {
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

export interface ZFSSettingsSaved {
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  /** True when a password has been saved (value is never sent to client) */
  hasPassword: boolean;
  keyPath?: string;
  /** True when a passphrase has been saved (value is never sent to client) */
  hasPassphrase: boolean;
}

export interface SettingsSaved {
  docker: DockerSettingsSaved;
  zfs: ZFSSettingsSaved;
}
