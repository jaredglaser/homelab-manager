import type { Pool } from 'pg';
import type { ManagedHost, ManagedHostStatus } from '@/lib/deploy/types';

interface InsertHostParams {
  name: string;
  agentUrl: string;
  socketProxyUrl: string;
}

export class ManagedHostsRepository {
  constructor(private readonly pool: Pool) {}

  async getByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      `SELECT * FROM managed_hosts WHERE name = $1`,
      [name]
    );
    if (result.rows.length === 0) return null;
    return toManagedHost(result.rows[0]);
  }

  async getAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query(
      `SELECT * FROM managed_hosts ORDER BY name`
    );
    return result.rows.map(toManagedHost);
  }

  async insert(params: InsertHostParams): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, socket_proxy_url)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [params.name, params.agentUrl, params.socketProxyUrl]
    );
    return Number(result.rows[0].id);
  }

  async updateStatus(id: number, status: ManagedHostStatus): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET status = $2, updated_at = NOW() WHERE id = $1`,
      [id, status]
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET agent_version = $2, updated_at = NOW() WHERE id = $1`,
      [id, version]
    );
  }
}

function toManagedHost(row: Record<string, unknown>): ManagedHost {
  return {
    id: Number(row.id),
    name: row.name as string,
    agentUrl: row.agent_url as string,
    socketProxyUrl: row.socket_proxy_url as string,
    agentVersion: (row.agent_version as string) ?? null,
    status: row.status as ManagedHostStatus,
    createdAt: row.created_at as Date,
  };
}
