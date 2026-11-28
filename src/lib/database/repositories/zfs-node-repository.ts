import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { decryptValue, encryptValue } from '@/lib/crypto/encrypted-value';
import { parseRowEnum } from '@/lib/database/repositories/row-enum';
import { ZFS_NODE_STATES, type ZfsNodeFailure, type ZfsNodeSummary } from '@/lib/zfs/node-state';

export const ZFS_NODES_NOTIFY_CHANNEL = 'zfs_nodes_change';

/** What the worker needs to connect: the summary plus the decrypted key. */
export interface ZfsNodeConnection extends ZfsNodeSummary {
  username: string;
  privateKey: string;
}

export interface NewZfsNode {
  name: string;
  address: string;
  port: number;
  allowedFrom: string | null;
  privateKey: string;
  publicKey: string;
}

interface ZfsNodeRow {
  id: number;
  name: string;
  address: string;
  port: number;
  allowed_from: string | null;
  state: string;
  host_key_fingerprint: string | null;
  seen_host_key_fingerprint: string | null;
  last_success_at: Date | null;
}

interface ZfsNodeKeyRow extends ZfsNodeRow {
  username: string;
  private_key_jwe: string;
}

interface PublicKeyRow {
  name: string;
  public_key: string;
  allowed_from: string | null;
}

const SUMMARY_COLUMNS = `id, name, address, port, allowed_from, state, host_key_fingerprint,
  seen_host_key_fingerprint, last_success_at`;

function toSummary(row: ZfsNodeRow): ZfsNodeSummary {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    port: row.port,
    allowedFrom: row.allowed_from,
    state: parseRowEnum('zfs_nodes.state', row.state, ZFS_NODE_STATES),
    hostKeyFingerprint: row.host_key_fingerprint,
    seenHostKeyFingerprint: row.seen_host_key_fingerprint,
    lastSuccessAt: row.last_success_at === null ? null : row.last_success_at.getTime(),
  };
}

export class ZfsNodeNameTakenError extends Error {
  constructor(name: string) {
    super(`A ZFS node named ${name} already exists`);
    this.name = 'ZfsNodeNameTakenError';
  }
}

export class ZfsNodeRepository {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: MasterKeyring,
  ) {}

  /** Tells the worker to reconcile its collectors. A missed notify only delays pickup until the next one. */
  private async notifyChange(name: string): Promise<void> {
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [ZFS_NODES_NOTIFY_CHANNEL, name]);
    } catch (err) {
      console.error(`[ZfsNodeRepository] pg_notify failed for ${name}:`, err instanceof Error ? err.message : err);
    }
  }

  async list(): Promise<ZfsNodeSummary[]> {
    const result = await this.pool.query<ZfsNodeRow>(`SELECT ${SUMMARY_COLUMNS} FROM zfs_nodes ORDER BY name`);
    return result.rows.map(toSummary);
  }

  async findById(id: number): Promise<ZfsNodeSummary | null> {
    const result = await this.pool.query<ZfsNodeRow>(`SELECT ${SUMMARY_COLUMNS} FROM zfs_nodes WHERE id = $1`, [id]);
    return result.rows[0] ? toSummary(result.rows[0]) : null;
  }

  async create(input: NewZfsNode): Promise<ZfsNodeSummary> {
    const privateKeyJwe = await encryptValue(input.privateKey, this.keyring);
    let row: ZfsNodeRow | undefined;
    try {
      const result = await this.pool.query<ZfsNodeRow>(
        `INSERT INTO zfs_nodes (name, address, port, allowed_from, private_key_jwe, public_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${SUMMARY_COLUMNS}`,
        [input.name, input.address, input.port, input.allowedFrom, privateKeyJwe, input.publicKey],
      );
      row = result.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ZfsNodeNameTakenError(input.name);
      throw err;
    }
    if (!row) throw new Error(`zfs_nodes insert for ${input.name} returned no row`);
    await this.notifyChange(input.name);
    return toSummary(row);
  }

  async remove(id: number): Promise<ZfsNodeSummary | null> {
    const result = await this.pool.query<ZfsNodeRow>(`DELETE FROM zfs_nodes WHERE id = $1 RETURNING ${SUMMARY_COLUMNS}`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    await this.notifyChange(row.name);
    return toSummary(row);
  }

  async getPublicKey(id: number): Promise<{ name: string; publicKey: string; allowedFrom: string | null } | null> {
    const result = await this.pool.query<PublicKeyRow>(
      'SELECT name, public_key, allowed_from FROM zfs_nodes WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? { name: row.name, publicKey: row.public_key, allowedFrom: row.allowed_from } : null;
  }

  private async toConnection(row: ZfsNodeKeyRow): Promise<ZfsNodeConnection> {
    let privateKey: string;
    try {
      privateKey = await decryptValue(row.private_key_jwe, this.keyring);
    } catch {
      throw new Error(`ZFS node key decryption failed for ${row.name}`);
    }
    return { ...toSummary(row), username: row.username, privateKey };
  }

  async getConnection(id: number): Promise<ZfsNodeConnection | null> {
    const result = await this.pool.query<ZfsNodeKeyRow>(
      `SELECT ${SUMMARY_COLUMNS}, username, private_key_jwe FROM zfs_nodes WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? this.toConnection(result.rows[0]) : null;
  }

  /** Every node with a confirmed host key, which is every node the worker collects from. */
  async listConfirmedConnections(): Promise<ZfsNodeConnection[]> {
    const result = await this.pool.query<ZfsNodeKeyRow>(
      `SELECT ${SUMMARY_COLUMNS}, username, private_key_jwe FROM zfs_nodes
       WHERE host_key_fingerprint IS NOT NULL ORDER BY name`,
    );
    return Promise.all(result.rows.map((row) => this.toConnection(row)));
  }

  /** Records the key a node presented without trusting it. */
  async recordSeenHostKey(id: number, fingerprint: string): Promise<void> {
    await this.pool.query(
      `UPDATE zfs_nodes SET seen_host_key_fingerprint = $2 WHERE id = $1`,
      [id, fingerprint],
    );
  }

  /** Pins a fingerprint only if it is the one the node last presented, so a stale confirm cannot pin another key. */
  async confirmHostKey(id: number, fingerprint: string): Promise<boolean> {
    const result = await this.pool.query<{ name: string }>(
      `UPDATE zfs_nodes
          SET host_key_fingerprint = seen_host_key_fingerprint,
              seen_host_key_fingerprint = NULL,
              state = 'pending',
              state_changed_at = now()
        WHERE id = $1 AND seen_host_key_fingerprint = $2
        RETURNING name`,
      [id, fingerprint],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.notifyChange(row.name);
    return true;
  }

  /** Writes a state change, and the seen key when the node presented an unconfirmed one. Unchanged states are not rewritten. */
  async recordFailure(id: number, state: ZfsNodeFailure, seenFingerprint: string | null = null): Promise<void> {
    await this.pool.query(
      `UPDATE zfs_nodes
          SET state = $2,
              state_changed_at = CASE WHEN state = $2 THEN state_changed_at ELSE now() END,
              seen_host_key_fingerprint = COALESCE($3, seen_host_key_fingerprint)
        WHERE id = $1`,
      [id, state, seenFingerprint],
    );
  }

  async recordSuccess(id: number, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE zfs_nodes
          SET state = 'ok',
              state_changed_at = CASE WHEN state = 'ok' THEN state_changed_at ELSE now() END,
              last_success_at = $2
        WHERE id = $1`,
      [id, at],
    );
  }

  /** The verify step read both commands, so the node is working before the worker's first sample. */
  async recordVerified(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE zfs_nodes
          SET state = 'ok',
              state_changed_at = CASE WHEN state = 'ok' THEN state_changed_at ELSE now() END
        WHERE id = $1`,
      [id],
    );
  }
}
