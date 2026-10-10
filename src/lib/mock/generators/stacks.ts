import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import type { StackContainer, StackStatusEntry } from '@/types/stacks';
import { generateDockerInventorySnapshot } from '@/lib/mock/generators/docker';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';

// Demo compose projects: service names per stack, matching the container counts on MOCK_STACKS.
const STACK_SERVICES: Record<string, string[]> = {
  traefik: ['traefik', 'nginx-proxy'],
  plex: ['plex'],
  homeassistant: ['homeassistant'],
  monitoring: ['grafana', 'postgres'],
  jellyfin: ['jellyfin'],
  vaultwarden: ['vaultwarden'],
  pihole: ['pihole'],
  portainer: ['portainer'],
};

function toService(serviceKey: string): string | null {
  const sk = serviceKey.length > 0 ? serviceKey : null;
  return sk?.includes('/') ? (sk.split('/')[1] || null) : sk;
}

function toStackContainer(container: DockerInventorySnapshotContainer): StackContainer {
  return {
    id: container.containerId,
    name: container.name,
    status: container.state,
    image: container.image,
    service: toService(container.serviceKey),
    ports: container.ports,
    mounts: container.mounts,
  };
}

function buildEntry(now: Date, host: string, stack: string): StackStatusEntry | null {
  const services = STACK_SERVICES[stack];
  if (!services) return null;
  const snapshot = generateDockerInventorySnapshot(now);
  const containers: StackContainer[] = [];
  for (const service of services) {
    const def = DOCKER_ENTITIES.find((e) => e.containerName === service);
    if (!def || def.hostName !== host) continue;
    const container = snapshot.find((c) => c.containerId === def.containerId);
    if (container) containers.push(toStackContainer(container));
  }
  return containers.length > 0 ? { stack, host, containers, updated_at: now.toISOString() } : null;
}

export function generateStackStatusSnapshot(now: Date): StackStatusEntry[] {
  const entries: StackStatusEntry[] = [];
  for (const [stack, services] of Object.entries(STACK_SERVICES)) {
    const def = DOCKER_ENTITIES.find((e) => e.containerName === services[0]);
    if (!def) continue;
    const entry = buildEntry(now, def.hostName, stack);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function generateStackStatusEntry(now: Date, host: string, stack: string): StackStatusEntry | null {
  return buildEntry(now, host, stack);
}
