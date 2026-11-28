import type { Pool } from 'pg';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { ProxmoxClient, type ProxmoxProbe, type ProxmoxFailureKind } from '@/lib/clients/proxmox-client';
import {
  ProxmoxAddressTakenError,
  ProxmoxConnectionRepository,
  type ProxmoxConnectionInput,
} from '@/lib/database/repositories/proxmox-connection-repository';
import type { ProxmoxConnectionSummary } from '@/types/proxmox';
import type { SaveProxmoxConnectionInput, TestProxmoxConnectionInput } from '@/data/proxmox/schemas';

export interface ProxmoxConnectionDeps {
  repo: Pick<ProxmoxConnectionRepository, 'list' | 'create' | 'update' | 'remove' | 'getConnection'>;
  /** Throws a ProxmoxRequestError-shaped error (`kind`) when Proxmox cannot be read. */
  probe: (config: ProxmoxConfig) => Promise<ProxmoxProbe>;
  isAddressTaken: (err: unknown) => boolean;
}

export function createProxmoxConnectionDeps(pool: Pool, keyring: MasterKeyring): ProxmoxConnectionDeps {
  return {
    repo: new ProxmoxConnectionRepository(pool, keyring),
    probe: (config) => new ProxmoxClient(config).probe(),
    isAddressTaken: (err) => err instanceof ProxmoxAddressTakenError,
  };
}

export type SaveProxmoxConnectionResult =
  | { ok: true; connection: ProxmoxConnectionSummary }
  | { ok: false; code: 'address_taken' | 'not_found' };

export type TestProxmoxConnectionResult =
  | ({ ok: true } & ProxmoxProbe)
  | { ok: false; code: ProxmoxFailureKind | 'not_found' };

const FAILURE_KINDS: readonly ProxmoxFailureKind[] = ['unreachable', 'token_rejected', 'certificate_refused'];

function failureKind(err: unknown): ProxmoxFailureKind {
  const kind = (err as { kind?: unknown } | null)?.kind;
  return FAILURE_KINDS.includes(kind as ProxmoxFailureKind) ? (kind as ProxmoxFailureKind) : 'unreachable';
}

function toInput(data: SaveProxmoxConnectionInput): ProxmoxConnectionInput {
  return {
    name: data.name || data.address,
    address: data.address,
    port: data.port,
    tokenId: data.tokenId,
    allowSelfSignedCerts: data.allowSelfSignedCerts,
  };
}

export async function handleListProxmoxConnections(deps: Pick<ProxmoxConnectionDeps, 'repo'>): Promise<ProxmoxConnectionSummary[]> {
  return await deps.repo.list();
}

/** Saves without contacting Proxmox: a wrong secret is reported by the worker's state on the Proxmox page. */
export async function handleSaveProxmoxConnection(
  deps: Pick<ProxmoxConnectionDeps, 'repo' | 'isAddressTaken'>,
  data: SaveProxmoxConnectionInput,
): Promise<SaveProxmoxConnectionResult> {
  const input = toInput(data);
  try {
    if (data.id === undefined) {
      return { ok: true, connection: await deps.repo.create(input, data.tokenSecret) };
    }
    const updated = await deps.repo.update(data.id, input, data.tokenSecret === '' ? null : data.tokenSecret);
    return updated ? { ok: true, connection: updated } : { ok: false, code: 'not_found' };
  } catch (err) {
    if (deps.isAddressTaken(err)) return { ok: false, code: 'address_taken' };
    throw err;
  }
}

/** Runs from the web server, so a pass here says nothing about whether the worker can reach Proxmox. */
export async function handleTestProxmoxConnection(
  deps: Pick<ProxmoxConnectionDeps, 'repo' | 'probe'>,
  data: TestProxmoxConnectionInput,
): Promise<TestProxmoxConnectionResult> {
  let tokenSecret = data.tokenSecret;
  if (tokenSecret === '' && data.id !== undefined) {
    const stored = await deps.repo.getConnection(data.id);
    if (!stored) return { ok: false, code: 'not_found' };
    tokenSecret = stored.tokenSecret;
  }
  const config: ProxmoxConfig = {
    host: data.address,
    port: data.port,
    tokenId: data.tokenId,
    tokenSecret,
    allowSelfSignedCerts: data.allowSelfSignedCerts,
  };
  try {
    return { ok: true, ...(await deps.probe(config)) };
  } catch (err) {
    console.error(
      `[proxmox] Test connection to ${data.address}:${data.port} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, code: failureKind(err) };
  }
}

export async function handleRemoveProxmoxConnection(
  deps: Pick<ProxmoxConnectionDeps, 'repo'>,
  data: { id: number },
): Promise<{ removed: boolean }> {
  return { removed: (await deps.repo.remove(data.id)) !== null };
}
