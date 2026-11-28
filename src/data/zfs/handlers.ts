import type { NewZfsNode, ZfsNodeConnection } from '@/lib/database/repositories/zfs-node-repository';
import { ZfsNodeNameTakenError } from '@/lib/database/repositories/zfs-node-repository';
import type { ZfsNodeFailure, ZfsNodeSummary } from '@/lib/zfs/node-state';
import { buildSetupScript } from '@/lib/zfs/node-setup-script';
import { scanHostKey, verifyNode } from '@/lib/zfs/node-probe';
import type { ZfsSshTarget, ZfsSshTransport } from '@/lib/zfs/ssh-transport';

export interface ZfsNodeRepo {
  list(): Promise<ZfsNodeSummary[]>;
  findById(id: number): Promise<ZfsNodeSummary | null>;
  create(input: NewZfsNode): Promise<ZfsNodeSummary>;
  remove(id: number): Promise<ZfsNodeSummary | null>;
  getPublicKey(id: number): Promise<{ name: string; publicKey: string; allowedFrom: string | null } | null>;
  getConnection(id: number): Promise<ZfsNodeConnection | null>;
  recordSeenHostKey(id: number, fingerprint: string): Promise<void>;
  confirmHostKey(id: number, fingerprint: string): Promise<boolean>;
  recordFailure(id: number, state: ZfsNodeFailure, seenFingerprint?: string | null): Promise<void>;
  recordVerified(id: number): Promise<void>;
}

export interface ZfsNodeHandlerDeps {
  repo: ZfsNodeRepo;
  transport: ZfsSshTransport;
  /** Returns an OpenSSH private key and its `ssh-ed25519 <base64>` public key. */
  generateKeyPair: () => { privateKey: string; publicKey: string };
  /** How long the verify step waits on a quiet zpool_influxdb before taking its answer as complete. */
  probeQuietMs?: number;
}

export type CreateZfsNodeResult =
  | { ok: true; node: ZfsNodeSummary; setupScript: string }
  | { ok: false; code: 'name_taken' };

export type ScanZfsNodeResult =
  | { ok: true; fingerprint: string; confirmed: boolean }
  | { ok: false; failure: ZfsNodeFailure | 'not_found' };

export type VerifyZfsNodeResult =
  | { ok: true; pools: string[] }
  | { ok: false; failure: ZfsNodeFailure | 'not_found' | 'not_confirmed'; fingerprint: string | null };

function target(node: ZfsNodeConnection): ZfsSshTarget {
  return { host: node.address.replace(/^\[(.*)\]$/, '$1'), port: node.port, username: node.username, privateKey: node.privateKey };
}

export async function handleListZfsNodes(deps: Pick<ZfsNodeHandlerDeps, 'repo'>): Promise<ZfsNodeSummary[]> {
  return deps.repo.list();
}

export async function handleCreateZfsNode(
  deps: ZfsNodeHandlerDeps,
  data: { name: string; address: string; port: number; allowedFrom: string | null },
): Promise<CreateZfsNodeResult> {
  const { privateKey, publicKey } = deps.generateKeyPair();
  let node: ZfsNodeSummary;
  try {
    node = await deps.repo.create({ ...data, privateKey, publicKey });
  } catch (err) {
    if (err instanceof ZfsNodeNameTakenError) return { ok: false, code: 'name_taken' };
    throw err;
  }
  return { ok: true, node, setupScript: buildSetupScript({ nodeName: node.name, publicKey, allowedFrom: node.allowedFrom }) };
}

export async function handleGetZfsNodeSetupScript(deps: Pick<ZfsNodeHandlerDeps, 'repo'>, data: { id: number }): Promise<{ setupScript: string } | null> {
  const key = await deps.repo.getPublicKey(data.id);
  if (!key) return null;
  return { setupScript: buildSetupScript({ nodeName: key.name, publicKey: key.publicKey, allowedFrom: key.allowedFrom }) };
}

/** Reads the host key the node presents, without logging in, and keeps it as the key waiting for a confirm. */
export async function handleScanZfsNodeHostKey(deps: ZfsNodeHandlerDeps, data: { id: number }): Promise<ScanZfsNodeResult> {
  const node = await deps.repo.getConnection(data.id);
  if (!node) return { ok: false, failure: 'not_found' };
  const scan = await scanHostKey(deps.transport, target(node));
  if (!scan.ok) return scan;
  if (scan.fingerprint === node.hostKeyFingerprint) return { ok: true, fingerprint: scan.fingerprint, confirmed: true };
  await deps.repo.recordSeenHostKey(node.id, scan.fingerprint);
  return { ok: true, fingerprint: scan.fingerprint, confirmed: false };
}

async function verify(deps: ZfsNodeHandlerDeps, node: ZfsNodeConnection): Promise<VerifyZfsNodeResult> {
  if (node.hostKeyFingerprint === null) return { ok: false, failure: 'not_confirmed', fingerprint: null };
  const result = await verifyNode(deps.transport, target(node), node.hostKeyFingerprint, deps.probeQuietMs);
  if (result.ok) {
    await deps.repo.recordVerified(node.id);
    return result;
  }
  await deps.repo.recordFailure(node.id, result.failure, result.failure === 'host_key_changed' ? result.fingerprint : null);
  return result;
}

/** Pins the fingerprint the user confirmed, then runs both reads once with it. */
export async function handleConfirmZfsNodeHostKey(
  deps: ZfsNodeHandlerDeps,
  data: { id: number; fingerprint: string },
): Promise<VerifyZfsNodeResult> {
  const confirmed = await deps.repo.confirmHostKey(data.id, data.fingerprint);
  if (!confirmed) {
    const node = await deps.repo.findById(data.id);
    if (!node) return { ok: false, failure: 'not_found', fingerprint: null };
    if (node.hostKeyFingerprint !== data.fingerprint) return { ok: false, failure: 'host_key_changed', fingerprint: node.seenHostKeyFingerprint };
  }
  const node = await deps.repo.getConnection(data.id);
  if (!node) return { ok: false, failure: 'not_found', fingerprint: null };
  return verify(deps, node);
}

export async function handleVerifyZfsNode(deps: ZfsNodeHandlerDeps, data: { id: number }): Promise<VerifyZfsNodeResult> {
  const node = await deps.repo.getConnection(data.id);
  if (!node) return { ok: false, failure: 'not_found', fingerprint: null };
  return verify(deps, node);
}

export async function handleRemoveZfsNode(deps: Pick<ZfsNodeHandlerDeps, 'repo'>, data: { id: number }): Promise<{ removed: boolean }> {
  return { removed: (await deps.repo.remove(data.id)) !== null };
}
