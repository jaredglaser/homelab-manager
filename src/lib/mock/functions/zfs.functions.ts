import type { ZFSStatsRow } from '@/types/zfs';
import type { ZfsNodeSummary } from '@/lib/zfs/node-state';
import type { CreateZfsNodeResult, ScanZfsNodeResult, VerifyZfsNodeResult } from '@/data/zfs/handlers';
import { buildSetupScript } from '@/lib/zfs/node-setup-script';
import { generateZFSHistory } from '@/lib/mock/generators/zfs';
import { ZFS_ENTITIES } from '@/lib/mock/entities';

const MAX_HISTORY_SECONDS = 3600;

export const MOCK_HOST_KEY_FINGERPRINT = 'SHA256:96sjJIA4izdxRnnHp5TcRvboMBPu3SZeyP7fywlMOgQ';
const MOCK_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP3uMockDemoKeyNotARealKeyForAnyNode0';

/**
 * Mock: Get historical ZFS stats for preloading.
 * Matches the real `getHistoricalZFSStats` signature.
 */
export const getHistoricalZFSStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<ZFSStatsRow[]> => {
  const seconds = Math.min(opts?.data?.seconds ?? 60, MAX_HISTORY_SECONDS);
  return generateZFSHistory(seconds);
};

function mockNodes(): ZfsNodeSummary[] {
  const names = [...new Set(ZFS_ENTITIES.map((entity) => entity.host))].sort((a, b) => a.localeCompare(b));
  return names.map((name, index) => ({
    id: index + 1,
    name,
    address: `192.168.1.${30 + index}`,
    port: 22,
    allowedFrom: null,
    state: 'ok',
    hostKeyFingerprint: MOCK_HOST_KEY_FINGERPRINT,
    seenHostKeyFingerprint: null,
    lastSuccessAt: Date.now(),
  }));
}

function poolsOf(name: string): string[] {
  const pools = [...new Set(ZFS_ENTITIES.filter((entity) => entity.host === name).map((entity) => entity.pool))];
  return pools.length > 0 ? pools.sort((a, b) => a.localeCompare(b)) : ['rpool', 'tank'];
}

export async function listZfsNodes(): Promise<ZfsNodeSummary[]> {
  return mockNodes();
}

/** Stateless like the other demo mocks: the new node is returned but not kept. */
export async function createZfsNode(data: { name: string; address: string; port: number; allowedFrom?: string }): Promise<CreateZfsNodeResult> {
  if (mockNodes().some((node) => node.name === data.name)) return { ok: false, code: 'name_taken' };
  const node: ZfsNodeSummary = {
    id: 100,
    name: data.name,
    address: data.address,
    port: data.port,
    allowedFrom: data.allowedFrom || null,
    state: 'pending',
    hostKeyFingerprint: null,
    seenHostKeyFingerprint: null,
    lastSuccessAt: null,
  };
  return { ok: true, node, setupScript: buildSetupScript({ nodeName: node.name, publicKey: MOCK_PUBLIC_KEY, allowedFrom: node.allowedFrom }) };
}

export async function getZfsNodeSetupScript(data: { id: number }): Promise<{ setupScript: string } | null> {
  const node = mockNodes().find((candidate) => candidate.id === data.id);
  return { setupScript: buildSetupScript({ nodeName: node?.name ?? 'node', publicKey: MOCK_PUBLIC_KEY, allowedFrom: null }) };
}

export async function scanZfsNodeHostKey(data: { id: number }): Promise<ScanZfsNodeResult> {
  const node = mockNodes().find((candidate) => candidate.id === data.id);
  return { ok: true, fingerprint: MOCK_HOST_KEY_FINGERPRINT, confirmed: node !== undefined };
}

export async function confirmZfsNodeHostKey(data: { id: number }): Promise<VerifyZfsNodeResult> {
  const node = mockNodes().find((candidate) => candidate.id === data.id);
  return { ok: true, pools: node ? poolsOf(node.name) : ['rpool', 'tank'] };
}

export async function verifyZfsNode(data: { id: number }): Promise<VerifyZfsNodeResult> {
  return confirmZfsNodeHostKey(data);
}

export async function removeZfsNode(_data: { id: number }): Promise<{ removed: boolean }> {
  return { removed: true };
}
