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
  agent_url: string;
  capabilities: HostCapabilities;
  agent_version: string | null;
  status: HostStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHostInput {
  name: string;
  agent_url: string;
  capabilities?: HostCapabilities;
}

// No separate ManagedHostRow needed — SERIAL (INT4) returns JavaScript numbers
// from node-postgres, unlike BIGINT which returns strings. The query result
// rows match ManagedHost directly.

/**
 * Intentionally explicit field mapping (identity for now). Ensures the returned
 * object only contains known ManagedHost fields and guards against future column
 * additions leaking through via SELECT *.
 */
function rowToHost(row: ManagedHost): ManagedHost {
  return {
    id: row.id,
    name: row.name,
    agent_url: row.agent_url,
    capabilities: row.capabilities ?? {},
    agent_version: row.agent_version,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class HostRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateHostInput): Promise<ManagedHost> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, capabilities)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.agent_url, JSON.stringify(input.capabilities ?? {})]
    );
    return rowToHost(result.rows[0] as ManagedHost);
  }

  async findAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts ORDER BY name ASC'
    );
    return (result.rows as ManagedHost[]).map(rowToHost);
  }

  async findByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE name = $1',
      [name]
    );
    return result.rows.length > 0 ? rowToHost(result.rows[0] as ManagedHost) : null;
  }

  async findById(id: number): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? rowToHost(result.rows[0] as ManagedHost) : null;
  }

  async updateStatus(id: number, status: HostStatus): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_version = $1, updated_at = NOW() WHERE id = $2',
      [version, id]
    );
  }

  async update(id: number, fields: { name?: string; agent_url?: string; capabilities?: HostCapabilities }): Promise<ManagedHost> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (fields.name !== undefined) {
      params.push(fields.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (fields.agent_url !== undefined) {
      params.push(fields.agent_url);
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

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const result = await this.pool.query(
      `UPDATE managed_hosts SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) throw new Error(`Host with id ${id} not found`);
    return rowToHost(result.rows[0] as ManagedHost);
  }

  async delete(id: number): Promise<void> {
    await this.pool.query(
      'DELETE FROM managed_hosts WHERE id = $1',
      [id]
    );
  }
}
