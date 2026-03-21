export const AGENT_CONTAINER_NAME_PREFIX = 'homelab-agent-';

export function getAgentContainerName(hostId: number): string {
  return `${AGENT_CONTAINER_NAME_PREFIX}${hostId}`;
}
