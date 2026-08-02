import { createHash, timingSafeEqual } from 'node:crypto';
import { buildAnsibleInventory } from '@/lib/ansible/inventory';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { AnsibleConfig } from '@/lib/config/ansible-config';

export interface InventoryHandlerDeps {
  loadConfig: () => AnsibleConfig;
  listHosts: () => Promise<ManagedHost[]>;
}

/** Digests first so both operands are the same length; timingSafeEqual throws when they are not. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/**
 * Machine-authenticated read for the sidecar's dynamic inventory script. Deliberately
 * separate from the session cookie path: the caller is a service, not a browser, and it
 * gets exactly one thing, the host list, with no way to trigger a run.
 */
export async function handleInventoryRequest(
  request: Request,
  deps: InventoryHandlerDeps,
): Promise<Response> {
  let config: AnsibleConfig;
  try {
    config = deps.loadConfig();
  } catch {
    return new Response(JSON.stringify({ error: 'Ansible execution is disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!tokensMatch(bearerToken(request), config.sidecarToken)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const hosts = await deps.listHosts();
  const inventory = buildAnsibleInventory(hosts, {
    selfHostName: config.selfHostName,
    remoteUser: config.remoteUser,
    appdataRoot: config.appdataRoot,
  });

  return new Response(JSON.stringify(inventory), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
