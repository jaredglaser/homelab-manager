// src/lib/database/repositories/managed-hosts-repository.ts

import type { Pool } from 'pg';
import type { ManagedHost } from '@/lib/deploy/types';

interface InsertHostParams {
  name: string;
  agentUrl: string;
  agentTokenHash: string;
  socketProxyUrl: string;
}

export class ManagedHostsRepository {
  constructor(private pool: Pool) {}

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
      `INSERT INTO managed_hosts (name, agent_url, agent_token_hash, socket_proxy_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.name, params.agentUrl, params.agentTokenHash, params.socketProxyUrl]
    );
    return Number(result.rows[0].id);
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET status = $2 WHERE id = $1`,
      [id, status]
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET agent_version = $2 WHERE id = $1`,
      [id, version]
    );
  }
}

function toManagedHost(row: Record<string, unknown>): ManagedHost {
  return {
    id: Number(row.id),
    name: row.name as string,
    agentUrl: row.agent_url as string,
    agentTokenHash: row.agent_token_hash as string,
    socketProxyUrl: row.socket_proxy_url as string,
    agentVersion: (row.agent_version as string) ?? null,
    status: row.status as string,
    createdAt: row.created_at as Date,
  };
}
