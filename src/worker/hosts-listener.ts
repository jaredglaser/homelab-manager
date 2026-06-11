import { Client } from 'pg';
import type { DatabaseConfig } from '@/lib/clients/database-client';
import {
  HOSTS_NOTIFY_CHANNEL,
  type HostChangePayload,
} from '@/lib/database/repositories/host-repository';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { abortableSleep } from '@/lib/utils/abortable-sleep';

export type HostChangeHandler = (payload: HostChangePayload | null) => void | Promise<void>;

/**
 * Listens for PostgreSQL NOTIFY on `managed_hosts_change` and invokes
 * `onChange` so the worker can reconcile its per-host collector set
 * without being restarted. The payload is informational; on any notify
 * the receiver should re-read the host table and diff against current
 * state so out-of-band SQL changes (and dropped notifies) are tolerated.
 *
 * On a runtime connection error (e.g. a PostgreSQL restart) the listener
 * reconnects with exponential backoff, re-issues LISTEN, then dispatches a
 * null payload so the worker runs a full reconcile and catches up on any
 * host changes that happened during the disconnect window. Without this,
 * the worker would keep stale collector state until the process restarts.
 *
 * Implements AsyncDisposable for use with `await using` / AsyncDisposableStack.
 */
export class HostsListener implements AsyncDisposable {
  private client: Client;
  // Flips true the moment connect() resolves, before LISTEN runs. This lets
  // dispose() always end the socket if a connect succeeded, even when LISTEN
  // throws (in which case the previous `started`-based check would skip end()
  // and leak the socket).
  private connected = false;
  private reconnecting = false;
  private reconnectFailures = 0;

  constructor(
    private readonly dbConfig: DatabaseConfig,
    private readonly onChange: HostChangeHandler,
    private readonly signal: AbortSignal,
  ) {
    this.client = this.createClient();
  }

  private createClient(): Client {
    return new Client({
      host: this.dbConfig.host,
      port: this.dbConfig.port,
      database: this.dbConfig.database,
      user: this.dbConfig.user,
      password: this.dbConfig.password,
      // Forward SSL settings so the listener works in TLS-required deployments.
      // DatabaseClient applies the same shape to its pool config.
      ...(this.dbConfig.ssl
        ? { ssl: { rejectUnauthorized: this.dbConfig.sslRejectUnauthorized } }
        : {}),
    });
  }

  async start(): Promise<void> {
    await this.connectAndListen();

    this.signal.addEventListener('abort', () => {
      this.client.end().catch(() => {});
    });
  }

  private async connectAndListen(): Promise<void> {
    await this.client.connect();
    this.connected = true;
    await this.client.query(`LISTEN ${HOSTS_NOTIFY_CHANNEL}`);

    this.client.on('notification', (msg) => {
      void this.dispatch(msg.payload ?? null);
    });

    this.client.on('error', (err) => {
      console.error('[HostsListener] Connection error:', err);
      void this.reconnect();
    });
  }

  /**
   * Replace the broken client with a fresh connection, retrying with
   * exponential backoff (500ms base, 30s cap) until success or shutdown.
   * After reconnecting, dispatches a null payload so the worker reconciles
   * against the host table and picks up changes missed while disconnected.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.signal.aborted) return;
    this.reconnecting = true;

    // Drop listeners before end() so a late 'error' from the dead socket
    // can't trigger a second reconnect of an already-healthy client.
    this.client.removeAllListeners();
    await this.client.end().catch(() => {});
    this.connected = false;

    while (!this.signal.aborted) {
      try {
        await abortableSleep(
          backoffDelayMs(this.reconnectFailures, { baseMs: 500, capMs: 30_000 }),
          this.signal,
        );
      } catch {
        break; // shutdown during backoff wait
      }

      try {
        this.client = this.createClient();
        await this.connectAndListen();
        this.reconnectFailures = 0;
        this.reconnecting = false;
        console.info('[HostsListener] Reconnected, reconciling hosts');
        await this.dispatch(null);
        return;
      } catch (err) {
        this.reconnectFailures++;
        console.error(
          '[HostsListener] Reconnect failed:',
          err instanceof Error ? err.message : err,
        );
        await this.client.end().catch(() => {});
        this.connected = false;
      }
    }

    this.reconnecting = false;
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
    // End the underlying socket on any path where connect() succeeded.
    // Without this, a LISTEN failure between connect() and `started=true`
    // would leak the connection.
    if (this.connected) {
      await this.client.end().catch(() => {});
    }
  }
}
