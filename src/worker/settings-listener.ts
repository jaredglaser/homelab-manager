import { Client } from 'pg';
import type { DatabaseConfig } from '@/lib/clients/database-client';
import type { SettingsRepository } from '@/lib/database/repositories/settings-repository';

export type SettingChangeHandler = (key: string, value: string | null) => void;

/**
 * Listens for PostgreSQL NOTIFY on 'settings_change' and calls `onChange`
 * when a watched key changes. Reads the current value from the DB so
 * the handler always receives the authoritative state.
 *
 * Implements AsyncDisposable for use with `await using` / AsyncDisposableStack.
 */
export class SettingsListener implements AsyncDisposable {
  private client: Client;
  private started = false;

  constructor(
    dbConfig: DatabaseConfig,
    private readonly settingsRepo: SettingsRepository,
    private readonly watchKeys: readonly string[],
    private readonly onChange: SettingChangeHandler,
    private readonly signal: AbortSignal,
  ) {
    this.client = new Client({
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
    });
  }

  /**
   * Connect, subscribe to LISTEN, read initial values, and wire up
   * notification handling + abort cleanup.
   */
  async start(): Promise<void> {
    await this.client.connect();
    await this.client.query('LISTEN settings_change');
    this.started = true;

    // Read initial values for all watched keys
    await this.loadInitialValues();

    this.client.on('notification', async (msg) => {
      if (msg.payload && this.watchKeys.includes(msg.payload)) {
        try {
          const value = await this.settingsRepo.get(msg.payload);
          this.onChange(msg.payload, value);
        } catch {
          // DB read failed — keep current value
        }
      }
    });

    this.client.on('error', (err) => {
      console.error('[SettingsListener] Connection error:', err);
    });

    this.signal.addEventListener('abort', () => {
      this.client.end().catch(() => {});
    });
  }

  /**
   * Read the current value for every watched key and call onChange.
   * Swallows errors — if the DB isn't ready, we keep defaults.
   */
  private async loadInitialValues(): Promise<void> {
    try {
      for (const key of this.watchKeys) {
        const value = await this.settingsRepo.get(key);
        this.onChange(key, value);
      }
    } catch {
      // DB read failed — keep defaults (off)
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.started) {
      await this.client.end().catch(() => {});
    }
  }
}
