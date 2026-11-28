import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { decryptValue, encryptValue } from '@/lib/crypto/encrypted-value';
import type { ProxmoxConnection } from '@/lib/config/proxmox-config';
import type { ProxmoxConnectionSummary } from '@/types/proxmox';

export const PROXMOX_CONNECTIONS_NOTIFY_CHANNEL = 'proxmox_connections_change';

export interface ProxmoxConnectionInput {
  name: string;
  address: string;
  port: number;
  tokenId: string;
  allowSelfSignedCerts: boolean;
}

/** A saved connection for the worker. `connection` is null when its secret cannot be decrypted with the loaded keys. */
export interface ProxmoxConnectionForWorker {
  id: number;
  name: string;
  connection: ProxmoxConnection | null;
}

interface ConnectionRow {
  id: number;
  name: string;
  address: string;
  port: number;
  token_id: string;
  allow_self_signed: boolean;
}

interface ConnectionSecretRow extends ConnectionRow {
  token_secret_jwe: string;
}

export class ProxmoxAddressTakenError extends Error {
  constructor(readonly address: string) {
    super(`A Proxmox connection to ${address} already exists`);
    this.name = 'ProxmoxAddressTakenError';
  }
}

function toSummary(row: ConnectionRow): ProxmoxConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    port: row.port,
    tokenId: row.token_id,
    allowSelfSignedCerts: row.allow_self_signed,
  };
}

function rethrowAddressTaken(err: unknown, address: string): never {
  if ((err as { code?: string }).code === '23505') throw new ProxmoxAddressTakenError(address);
  throw err;
}

export class ProxmoxConnectionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: MasterKeyring,
  ) {}

  /** Tells the worker to reconcile its collectors and the page to reload its state. A missed notify only delays pickup. */
  private async notifyChange(id: number): Promise<void> {
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [PROXMOX_CONNECTIONS_NOTIFY_CHANNEL, String(id)]);
    } catch (err) {
      console.error(`[ProxmoxConnectionRepository] pg_notify failed for ${id}:`, err instanceof Error ? err.message : err);
    }
  }

  async list(): Promise<ProxmoxConnectionSummary[]> {
    const result = await this.pool.query<ConnectionRow>(`SELECT id, name, address, port, token_id, allow_self_signed FROM proxmox_connections ORDER BY id`);
    return result.rows.map(toSummary);
  }

  async create(input: ProxmoxConnectionInput, tokenSecret: string): Promise<ProxmoxConnectionSummary> {
    const secretJwe = await encryptValue(tokenSecret, this.keyring);
    let row: ConnectionRow | undefined;
    try {
      const result = await this.pool.query<ConnectionRow>(
        `INSERT INTO proxmox_connections (name, address, port, token_id, token_secret_jwe, allow_self_signed)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, address, port, token_id, allow_self_signed`,
        [input.name, input.address, input.port, input.tokenId, secretJwe, input.allowSelfSignedCerts],
      );
      row = result.rows.at(0);
    } catch (err) {
      rethrowAddressTaken(err, input.address);
    }
    if (!row) throw new Error(`proxmox_connections insert for ${input.address} returned no row`);
    await this.notifyChange(row.id);
    return toSummary(row);
  }

  /** A null `tokenSecret` keeps the stored one. Returns null when no connection has this id. */
  async update(id: number, input: ProxmoxConnectionInput, tokenSecret: string | null): Promise<ProxmoxConnectionSummary | null> {
    const secretJwe = tokenSecret === null ? null : await encryptValue(tokenSecret, this.keyring);
    let row: ConnectionRow | undefined;
    try {
      const result = await this.pool.query<ConnectionRow>(
        `UPDATE proxmox_connections
            SET name = $2, address = $3, port = $4, token_id = $5,
                token_secret_jwe = COALESCE($6, token_secret_jwe),
                allow_self_signed = $7, updated_at = now()
          WHERE id = $1
          RETURNING id, name, address, port, token_id, allow_self_signed`,
        [id, input.name, input.address, input.port, input.tokenId, secretJwe, input.allowSelfSignedCerts],
      );
      row = result.rows.at(0);
    } catch (err) {
      rethrowAddressTaken(err, input.address);
    }
    if (!row) return null;
    await this.notifyChange(id);
    return toSummary(row);
  }

  /** Removes the connection and its recorded state. Its stats rows stay. */
  async remove(id: number): Promise<ProxmoxConnectionSummary | null> {
    const result = await this.pool.query<ConnectionRow>(
      'DELETE FROM proxmox_connections WHERE id = $1 RETURNING id, name, address, port, token_id, allow_self_signed',
      [id],
    );
    const row = result.rows.at(0);
    if (!row) return null;
    await this.pool.query('DELETE FROM proxmox_collector_state WHERE connection_id = $1', [String(id)]);
    await this.notifyChange(id);
    return toSummary(row);
  }

  private async decryptSecret(row: ConnectionSecretRow): Promise<string> {
    try {
      return await decryptValue(row.token_secret_jwe, this.keyring);
    } catch {
      throw new Error(`Proxmox token secret decryption failed for connection ${row.id}`);
    }
  }

  private toConnection(row: ConnectionSecretRow, tokenSecret: string): ProxmoxConnection {
    return {
      id: row.id,
      name: row.name,
      host: row.address,
      port: row.port,
      tokenId: row.token_id,
      tokenSecret,
      allowSelfSignedCerts: row.allow_self_signed,
    };
  }

  async getConnection(id: number): Promise<ProxmoxConnection | null> {
    const result = await this.pool.query<ConnectionSecretRow>(
      `SELECT id, name, address, port, token_id, allow_self_signed, token_secret_jwe FROM proxmox_connections WHERE id = $1`,
      [id],
    );
    const row = result.rows.at(0);
    return row ? this.toConnection(row, await this.decryptSecret(row)) : null;
  }

  async listForWorker(): Promise<ProxmoxConnectionForWorker[]> {
    const result = await this.pool.query<ConnectionSecretRow>(
      `SELECT id, name, address, port, token_id, allow_self_signed, token_secret_jwe FROM proxmox_connections ORDER BY id`,
    );
    return await Promise.all(result.rows.map(async (row): Promise<ProxmoxConnectionForWorker> => {
      try {
        return { id: row.id, name: row.name, connection: this.toConnection(row, await this.decryptSecret(row)) };
      } catch (err) {
        console.error('[ProxmoxConnectionRepository]', err instanceof Error ? err.message : err);
        return { id: row.id, name: row.name, connection: null };
      }
    }));
  }
}
