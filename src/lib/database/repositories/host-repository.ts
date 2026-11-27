import type { Pool } from 'pg';
import { parseNullableRowEnum, parseRowEnum, parseRowEnumOr } from '@/lib/database/repositories/row-enum';
import { AGENT_INVENTORY_NOTIFY_CHANNEL, zAgentUpdateResult } from '@/lib/hosts/agent-inventory';
import type { AgentUpdateResult, StoredAgentUpdate } from '@/lib/hosts/agent-inventory';
import { HOST_PROBE_FAILURE_CODES, MAX_FAILURE_DETAIL_LENGTH } from '@/lib/errors/host-failure-copy';
import type { HostProbeFailureCode } from '@/lib/errors/host-failure-copy';

/** Valid statuses for managed_hosts, matching the DB CHECK constraint in migration 010. */
export const HOST_STATUS_VALUES = ['pending', 'healthy', 'unhealthy', 'error'] as const;
export type HostStatus = (typeof HOST_STATUS_VALUES)[number];

export interface HostCapabilities {
  docker?: boolean;
  zfs?: boolean;
}

export interface HostFailureRecord {
  code: HostProbeFailureCode;
  detail: string | null;
}

/** An unhealthy host always names its cause, and a healthy one never carries one (managed_hosts_failure_check). */
export type HostHealthVerdict =
  | { status: 'healthy'; failure: null }
  | { status: 'pending'; failure: HostFailureRecord | null }
  | { status: 'unhealthy'; failure: HostFailureRecord };

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
  /** Null when the last probe succeeded or the host has never been probed. */
  failure: HostFailureRecord | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * When the inventory sweep last probed this host, or null if it has never been
   * swept. Deliberately separate from updatedAt, which every writer to this row
   * bumps and so cannot answer "when was this agent last checked".
   */
  lastSweptAt: Date | null;
  agentUpdate: StoredAgentUpdate | null;
}

export type SettledAgentUpdate = { state: 'done'; result: AgentUpdateResult } | { state: 'interrupted' };

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
  id: number;
  name: string;
  agent_url: string;
  capabilities: HostCapabilities;
  agent_version: string | null;
  agent_image: string | null;
  agent_image_tag: string | null;
  agent_image_digest: string | null;
  agent_out_of_date: boolean;
  status: string;
  failure_code: string | null;
  failure_detail: string | null;
  created_at: Date;
  updated_at: Date;
  last_swept_at: Date | null;
  agent_update_state: string | null;
  agent_update_result: Record<string, unknown> | null;
  agent_update_at: Date | null;
}

interface HostIdRow {
  id: number;
}

interface HostNameRow {
  name: string;
}

function toFailureRecord(row: ManagedHostRow): HostFailureRecord | null {
  const code: HostProbeFailureCode | null = parseNullableRowEnum('managed_hosts.failure_code', row.failure_code, HOST_PROBE_FAILURE_CODES);
  return code === null ? null : { code, detail: row.failure_detail };
}

const AGENT_UPDATE_STATES = ['running', 'done', 'interrupted'] as const;

// A row a newer build wrote reads as no update, so one unknown value cannot blank the whole Hosts page.
function toAgentUpdate(row: ManagedHostRow): StoredAgentUpdate | null {
  if (row.agent_update_state === null || row.agent_update_at === null) return null;
  const state = parseRowEnumOr('managed_hosts.agent_update_state', row.agent_update_state, AGENT_UPDATE_STATES, null);
  if (state === null) return null;
  if (state !== 'done') return { state, at: row.agent_update_at };
  const result = zAgentUpdateResult.safeParse(row.agent_update_result);
  if (!result.success) {
    console.error(`[repositories] Unrecognized managed_hosts.agent_update_result for host ${row.id}, read as no update`);
    return null;
  }
  return { state, at: row.agent_update_at, result: result.data };
}

function toManagedHost(row: ManagedHostRow): ManagedHost {
  return {
    id: row.id,
    name: row.name,
    agentUrl: row.agent_url,
    capabilities: row.capabilities,
    agentVersion: row.agent_version,
    agentImage: row.agent_image,
    agentImageTag: row.agent_image_tag,
    agentImageDigest: row.agent_image_digest,
    agentOutOfDate: row.agent_out_of_date,
    status: parseRowEnum('managed_hosts.status', row.status, HOST_STATUS_VALUES),
    failure: toFailureRecord(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSweptAt: row.last_swept_at,
    agentUpdate: toAgentUpdate(row),
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

  /** The worker's HostsListener reconciles collectors on managed_hosts_change, so an update's progress goes out on the inventory channel instead. */
  private async notifyInventoryChange(hostIds: number[]): Promise<void> {
    try {
      await this.pool.query(`SELECT pg_notify($1, $2)`, [AGENT_INVENTORY_NOTIFY_CHANNEL, JSON.stringify({ hostIds })]);
    } catch (err) {
      console.error(
        `[HostRepository] pg_notify(${AGENT_INVENTORY_NOTIFY_CHANNEL}) failed for hosts ${hostIds.join(', ')}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** False when an update is already running on the host: the claim is what keeps a second request from reaching the agent. */
  async claimAgentUpdate(id: number, startedAt: Date): Promise<boolean> {
    const result = await this.pool.query<HostIdRow>(
      `UPDATE managed_hosts SET agent_update_state = 'running', agent_update_result = NULL, agent_update_at = $2
       WHERE id = $1 AND agent_update_state IS DISTINCT FROM 'running'
       RETURNING id`,
      [id, startedAt],
    );
    if (result.rows.length === 0) return false;
    await this.notifyInventoryChange([id]);
    return true;
  }

  /** Ends only the update that started at `startedAt`, so a late write never ends a newer update. */
  async settleAgentUpdate(id: number, startedAt: Date, settled: SettledAgentUpdate, at: Date): Promise<void> {
    const result = await this.pool.query<HostIdRow>(
      `UPDATE managed_hosts SET agent_update_state = $3, agent_update_result = $4::jsonb, agent_update_at = $5
       WHERE id = $1 AND agent_update_state = 'running' AND agent_update_at = $2
       RETURNING id`,
      [
        id,
        startedAt,
        settled.state,
        settled.state === 'done' ? JSON.stringify(settled.result) : null,
        at,
      ],
    );
    if (result.rows.length > 0) await this.notifyInventoryChange([id]);
  }

  async interruptAgentUpdates(startedBefore: Date, at: Date): Promise<number[]> {
    const result = await this.pool.query<HostIdRow>(
      `UPDATE managed_hosts SET agent_update_state = 'interrupted', agent_update_at = $2
       WHERE agent_update_state = 'running' AND agent_update_at < $1
       RETURNING id`,
      [startedBefore, at],
    );
    const ids = result.rows.map((row) => row.id);
    if (ids.length > 0) await this.notifyInventoryChange(ids);
    return ids;
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
    return result.rows[0].id;
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

  /**
   * Written only while the row still has the URL the verdict was probed at, so an edited host never gets its old URL's verdict back.
   * A pending verdict only lands on a row that is still pending: pending grants plaintext enrollment, so a probe that read the row
   * before a concurrent check verified it must not hand that back.
   */
  async updateHealth(id: number, verdict: HostHealthVerdict, probedUrl: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET status = $1::text, failure_code = $2, failure_detail = $3, updated_at = NOW()
       WHERE id = $4 AND agent_url = $5 AND ($1::text <> 'pending' OR status = 'pending')`,
      [
        verdict.status,
        verdict.failure?.code ?? null,
        verdict.failure?.detail?.slice(0, MAX_FAILURE_DETAIL_LENGTH) ?? null,
        id,
        probedUrl,
      ],
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
