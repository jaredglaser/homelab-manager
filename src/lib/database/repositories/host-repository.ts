import type { Pool } from 'pg';

/** Valid statuses for managed_hosts, matching the DB CHECK constraint in migration 010. */
export type HostStatus = 'pending' | 'healthy' | 'unhealthy' | 'error';

export interface HostCapabilities {
  docker?: boolean;
  zfs?: boolean;
}

export interface ManagedHost {
  id: number;
  name: string;
  agentUrl: string;
  capabilities: HostCapabilities;
  agentVersion: string | null;
  status: HostStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateHostInput {
  name: string;
  agentUrl: string;
  capabilities?: HostCapabilities;
}

export interface UpdateHostInput {
  name?: string;
  agentUrl?: string;
  capabilities?: HostCapabilities;
}

function toManagedHost(row: Record<string, unknown>): ManagedHost {
  return {
    id: Number(row.id),
    name: row.name as string,
    agentUrl: row.agent_url as string,
    capabilities: (row.capabilities as HostCapabilities) ?? {},
    agentVersion: (row.agent_version as string | null | undefined) ?? null,
    status: row.status as HostStatus,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/** Notification channel the worker LISTENs on to react to host adds/updates/removes. */
export const HOSTS_NOTIFY_CHANNEL = 'managed_hosts_change';

export type HostChangeOp = 'add' | 'update' | 'remove';

export interface HostChangePayload {
  op: HostChangeOp;
  name: string;
}

export class HostRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Emit a NOTIFY so the worker's HostsListener can reconcile its collector
   * set without restarting. Failure to notify is logged but never bubbles up:
   * the DB write already succeeded and a missed notify only delays pickup
   * until the next mutation or worker restart, which is preferable to
   * rolling back the user-visible operation.
   */
  private async notifyChange(op: HostChangeOp, name: string): Promise<void> {
    try {
      await this.pool.query(`SELECT pg_notify($1, $2)`, [
        HOSTS_NOTIFY_CHANNEL,
        JSON.stringify({ op, name } satisfies HostChangePayload),
      ]);
    } catch (err) {
      console.error(
        `[HostRepository] pg_notify(${HOSTS_NOTIFY_CHANNEL}) failed for ${op} ${name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async create(input: CreateHostInput): Promise<ManagedHost> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, capabilities)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.agentUrl, JSON.stringify(input.capabilities ?? {})],
    );
    const host = toManagedHost(result.rows[0] as Record<string, unknown>);
    await this.notifyChange('add', host.name);
    return host;
  }

  async insert(input: CreateHostInput): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, capabilities)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.name, input.agentUrl, JSON.stringify(input.capabilities ?? {})],
    );
    await this.notifyChange('add', input.name);
    return Number((result.rows[0] as Record<string, unknown>).id);
  }

  async findAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts ORDER BY name ASC',
    );
    return result.rows.map((row) => toManagedHost(row as Record<string, unknown>));
  }

  async getAll(): Promise<ManagedHost[]> {
    return this.findAll();
  }

  async findByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE name = $1',
      [name],
    );
    return result.rows.length > 0 ? toManagedHost(result.rows[0] as Record<string, unknown>) : null;
  }

  async getByName(name: string): Promise<ManagedHost | null> {
    return this.findByName(name);
  }

  async findById(id: number): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE id = $1',
      [id],
    );
    return result.rows.length > 0 ? toManagedHost(result.rows[0] as Record<string, unknown>) : null;
  }

  async updateStatus(id: number, status: HostStatus): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id],
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_version = $1, updated_at = NOW() WHERE id = $2',
      [version, id],
    );
  }

  async updateAgentUrl(id: number, agentUrl: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE managed_hosts SET agent_url = $1, updated_at = NOW()
       WHERE id = $2 RETURNING name`,
      [agentUrl, id],
    );
    if (result.rows.length > 0) {
      await this.notifyChange('update', (result.rows[0] as { name: string }).name);
    }
  }

  async update(id: number, fields: UpdateHostInput): Promise<ManagedHost> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (fields.name !== undefined) {
      params.push(fields.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (fields.agentUrl !== undefined) {
      params.push(fields.agentUrl);
      setClauses.push(`agent_url = $${params.length}`);
    }
    if (fields.capabilities !== undefined) {
      params.push(JSON.stringify(fields.capabilities));
      setClauses.push(`capabilities = $${params.length}`);
    }

    if (setClauses.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Host with id ${id} not found`);
      return existing;
    }

    setClauses.push('updated_at = NOW()');
    params.push(id);

    const result = await this.pool.query(
      `UPDATE managed_hosts SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );

    if (result.rows.length === 0) throw new Error(`Host with id ${id} not found`);
    const host = toManagedHost(result.rows[0] as Record<string, unknown>);
    await this.notifyChange('update', host.name);
    return host;
  }

  async delete(id: number): Promise<void> {
    // Capture the name before deletion so the NOTIFY payload identifies the
    // removed host. Skipping if the row isn't present keeps the method idempotent.
    const result = await this.pool.query(
      `DELETE FROM managed_hosts WHERE id = $1 RETURNING name`,
      [id],
    );
    if (result.rows.length > 0) {
      await this.notifyChange('remove', (result.rows[0] as { name: string }).name);
    }
  }
}
