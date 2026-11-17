import type { Pool } from 'pg';
import { parseRowEnum } from '@/lib/database/repositories/row-enum';

/** Valid statuses for managed_hosts, matching the DB CHECK constraint in migration 010. */
export const HOST_STATUS_VALUES = ['pending', 'healthy', 'unhealthy', 'error'] as const;
export type HostStatus = (typeof HOST_STATUS_VALUES)[number];

export function isHostStatus(value: unknown): value is HostStatus {
  return typeof value === 'string' && (HOST_STATUS_VALUES as readonly string[]).includes(value);
}

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
  agentImage: string | null;
  agentImageTag: string | null;
  /** Image digest the agent container runs, reported by the agent's /info and persisted by the sweep. */
  agentImageDigest: string | null;
  /** True when the last sweep found this digest different from the manager's own agent image. */
  agentOutOfDate: boolean;
  status: HostStatus;
  createdAt: Date;
  updatedAt: Date;
  /**
   * When the inventory sweep last probed this host, or null if it has never been
   * swept. Deliberately separate from updatedAt, which every writer to this row
   * bumps and so cannot answer "when was this agent last checked".
   */
  lastSweptAt: Date | null;
}

export interface CreateHostInput {
  name: string;
  agentUrl: string;
  capabilities?: HostCapabilities;
}

export interface UpdateAgentInfoInput {
  version?: string;
  image?: string | null;
  imageTag?: string | null;
  imageDigest?: string | null;
  outOfDate?: boolean;
}

export interface UpdateHostInput {
  name?: string;
  agentUrl?: string;
  capabilities?: HostCapabilities;
}

interface ManagedHostRow {
  id: number | string;
  name: string;
  agent_url: string;
  capabilities: HostCapabilities | null;
  agent_version?: string | null;
  agent_image?: string | null;
  agent_image_tag?: string | null;
  agent_image_digest?: string | null;
  agent_out_of_date?: boolean | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_swept_at?: Date | null;
}

interface HostIdRow {
  id: number | string;
}

interface HostNameRow {
  name: string;
}

function toManagedHost(row: ManagedHostRow): ManagedHost {
  return {
    id: Number(row.id),
    name: row.name,
    agentUrl: row.agent_url,
    capabilities: row.capabilities ?? {},
    agentVersion: row.agent_version ?? null,
    agentImage: row.agent_image ?? null,
    agentImageTag: row.agent_image_tag ?? null,
    agentImageDigest: row.agent_image_digest ?? null,
    agentOutOfDate: row.agent_out_of_date ?? false,
    status: parseRowEnum('managed_hosts.status', row.status, isHostStatus),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSweptAt: row.last_swept_at ?? null,
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
    const result = await this.pool.query<ManagedHostRow>(
      `INSERT INTO managed_hosts (name, agent_url, capabilities)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.agentUrl, JSON.stringify(input.capabilities ?? {})],
    );
    const host = toManagedHost(result.rows[0]);
    await this.notifyChange('add', host.name);
    return host;
  }

  async insert(input: CreateHostInput): Promise<number> {
    const result = await this.pool.query<HostIdRow>(
      `INSERT INTO managed_hosts (name, agent_url, capabilities)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.name, input.agentUrl, JSON.stringify(input.capabilities ?? {})],
    );
    await this.notifyChange('add', input.name);
    return Number(result.rows[0].id);
  }

  async findAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query<ManagedHostRow>(
      'SELECT * FROM managed_hosts ORDER BY name ASC',
    );
    return result.rows.map(toManagedHost);
  }

  async getAll(): Promise<ManagedHost[]> {
    return await this.findAll();
  }

  async findByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query<ManagedHostRow>(
      'SELECT * FROM managed_hosts WHERE name = $1',
      [name],
    );
    return result.rows.length > 0 ? toManagedHost(result.rows[0]) : null;
  }

  async getByName(name: string): Promise<ManagedHost | null> {
    return await this.findByName(name);
  }

  async findById(id: number): Promise<ManagedHost | null> {
    const result = await this.pool.query<ManagedHostRow>(
      'SELECT * FROM managed_hosts WHERE id = $1',
      [id],
    );
    return result.rows.length > 0 ? toManagedHost(result.rows[0]) : null;
  }

  async updateStatus(id: number, status: HostStatus): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id],
    );
  }

  /**
   * Record that the inventory sweep probed this host at `at`. Deliberately does
   * not touch updated_at: that column is bumped by every writer and is what made
   * the inventory report a fresher sweep than actually ran. Stamped for every
   * probed host, including a pending one whose status is left alone, because
   * checkedAt answers "when did we last look", not "when did the status change".
   */
  async updateLastSweptAt(id: number, at: Date): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET last_swept_at = $1 WHERE id = $2',
      [at, id],
    );
  }

  /** An omitted field is left as it was; an explicit null clears it. */
  async updateAgentInfo(id: number, fields: UpdateAgentInfoInput): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (fields.version !== undefined) {
      params.push(fields.version);
      setClauses.push(`agent_version = $${params.length}`);
    }
    if (fields.image !== undefined) {
      params.push(fields.image);
      setClauses.push(`agent_image = $${params.length}`);
    }
    if (fields.imageTag !== undefined) {
      params.push(fields.imageTag);
      setClauses.push(`agent_image_tag = $${params.length}`);
    }
    if (fields.imageDigest !== undefined) {
      params.push(fields.imageDigest);
      setClauses.push(`agent_image_digest = $${params.length}`);
    }
    if (fields.outOfDate !== undefined) {
      params.push(fields.outOfDate);
      setClauses.push(`agent_out_of_date = $${params.length}`);
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = NOW()');
    params.push(id);

    await this.pool.query(
      `UPDATE managed_hosts SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params,
    );
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

    const result = await this.pool.query<ManagedHostRow>(
      `UPDATE managed_hosts SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );

    if (result.rows.length === 0) throw new Error(`Host with id ${id} not found`);
    const host = toManagedHost(result.rows[0]);
    await this.notifyChange('update', host.name);
    return host;
  }

  async delete(id: number): Promise<void> {
    // Capture the name before deletion so the NOTIFY payload identifies the
    // removed host. Skipping if the row isn't present keeps the method idempotent.
    const result = await this.pool.query<HostNameRow>(
      `DELETE FROM managed_hosts WHERE id = $1 RETURNING name`,
      [id],
    );
    if (result.rows.length > 0) {
      await this.notifyChange('remove', result.rows[0].name);
    }
  }
}
