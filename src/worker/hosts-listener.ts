import { Client } from 'pg';
import type { DatabaseConfig } from '@/lib/clients/database-client';
import {
  HOSTS_NOTIFY_CHANNEL,
  type HostChangePayload,
} from '@/lib/database/repositories/host-repository';

export type HostChangeHandler = (payload: HostChangePayload | null) => void | Promise<void>;

/**
 * Listens for PostgreSQL NOTIFY on `managed_hosts_change` and invokes
 * `onChange` so the worker can reconcile its per-host collector set
 * without being restarted. The payload is informational; on any notify
 * the receiver should re-read the host table and diff against current
 * state so out-of-band SQL changes (and dropped notifies) are tolerated.
 *
 * Implements AsyncDisposable for use with `await using` / AsyncDisposableStack.
 */
export class HostsListener implements AsyncDisposable {
  private client: Client;
  private started = false;

  constructor(
    dbConfig: DatabaseConfig,
    private readonly onChange: HostChangeHandler,
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

  async start(): Promise<void> {
    await this.client.connect();
    await this.client.query(`LISTEN ${HOSTS_NOTIFY_CHANNEL}`);
    this.started = true;

    this.client.on('notification', (msg) => {
      void this.dispatch(msg.payload ?? null);
    });

    this.client.on('error', (err) => {
      console.error('[HostsListener] Connection error:', err);
    });

    this.signal.addEventListener('abort', () => {
      this.client.end().catch(() => {});
    });
  }

  private async dispatch(rawPayload: string | null): Promise<void> {
    let parsed: HostChangePayload | null = null;
    if (rawPayload) {
      try {
        const obj = JSON.parse(rawPayload) as Partial<HostChangePayload>;
        if (
          (obj.op === 'add' || obj.op === 'update' || obj.op === 'remove') &&
          typeof obj.name === 'string'
        ) {
          parsed = { op: obj.op, name: obj.name };
        }
      } catch {
        // Malformed payloads still fall through to a reconcile so we never
        // miss a change due to one bad notify.
      }
    }
    try {
      await this.onChange(parsed);
    } catch (err) {
      console.error('[HostsListener] onChange failed:', err instanceof Error ? err.message : err);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.started) {
      await this.client.end().catch(() => {});
    }
  }
}
