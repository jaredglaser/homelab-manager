import type { Pool } from 'pg';

export interface ManagedHost {
  id: number;
  name: string;
  agent_url: string;
  agent_token_hash: string;
  agent_token: string | null; // plaintext token for worker auth
  socket_proxy_url: string;
  agent_version: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHostInput {
  name: string;
  agent_url: string;
  agent_token_hash: string;
  agent_token: string; // plaintext token stored for worker use
  socket_proxy_url: string;
}

// No separate ManagedHostRow needed — SERIAL (INT4) returns JavaScript numbers
// from node-postgres, unlike BIGINT which returns strings. The query result
// rows match ManagedHost directly.

function rowToHost(row: ManagedHost): ManagedHost {
  return {
    id: row.id,
    name: row.name,
    agent_url: row.agent_url,
    agent_token_hash: row.agent_token_hash,
    agent_token: row.agent_token,
    socket_proxy_url: row.socket_proxy_url,
    agent_version: row.agent_version,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class HostRepository {
  constructor(private pool: Pool) {}

  async create(input: CreateHostInput): Promise<ManagedHost> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, agent_token_hash, agent_token, socket_proxy_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.name, input.agent_url, input.agent_token_hash, input.agent_token, input.socket_proxy_url]
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

  async updateStatus(id: number, status: string): Promise<void> {
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

  async updateTokenHash(id: number, tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_token_hash = $1, updated_at = NOW() WHERE id = $2',
      [tokenHash, id]
    );
  }

  async delete(id: number): Promise<void> {
    await this.pool.query(
      'DELETE FROM managed_hosts WHERE id = $1',
      [id]
    );
  }
}
