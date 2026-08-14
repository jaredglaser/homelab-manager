export interface ContainerKeyInput {
  name: string;
  /** Compose label pair as `project/service`, or null for a container outside a stack. */
  serviceKey: string | null;
}

/**
 * Stable identity for a container across redeploys.
 *
 * Docker ids change every time a stack is recreated, so keying analysis state
 * on them would throw away the learned skill on every `compose up`. The compose
 * service key survives a redeploy; a container outside a stack falls back to
 * its name, which is the closest thing it has to a stable identity.
 */
export function resolveContainerKey(container: ContainerKeyInput): string {
  const serviceKey = container.serviceKey?.trim();
  if (serviceKey && serviceKey.length > 0) return serviceKey;
  return container.name.replace(/^\//, '');
}

/** Fleet-wide entity id: `host/containerKey`. */
export function containerEntityId(host: string, containerKey: string): string {
  return `${host}/${containerKey}`;
}
