import type { StackSummary, StackDetail, StackDeployRecord, UIDeployRequest } from '@/types/stacks';

const MOCK_STACKS: StackSummary[] = [
  {
    name: 'plex',
    host: 'homeserver',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'plex',
  },
  {
    name: 'traefik',
    host: 'homeserver',
    syncStatus: 'pending',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 2,
    icon: 'traefik',
  },
  {
    name: 'pihole',
    host: 'pihole-host',
    syncStatus: 'failed',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 7_200_000).toISOString(),
    lastDeployStatus: 'failed',
    containerCount: 1,
    icon: 'pi-hole',
  },
  {
    name: 'homeassistant',
    host: 'homeserver',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 1_800_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'home-assistant',
  },
  {
    name: 'grafana',
    host: 'homeserver',
    syncStatus: 'in_sync',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 43_200_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 3,
    icon: 'grafana',
  },
];

const MOCK_COMPOSE = `version: '3.8'
services:
  app:
    image: \${APP_IMAGE:-myapp:latest}
    restart: unless-stopped
    ports:
      - "\${APP_PORT:-8080}:8080"
    environment:
      - DATABASE_URL=\${DATABASE_URL}
      - SECRET_KEY=\${SECRET_KEY}
    volumes:
      - app_data:/data

volumes:
  app_data:
`;

const MOCK_DEPLOY_HISTORY: StackDeployRecord[] = [
  {
    id: 3,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'a1b2c3d',
    envHash: 'abc123',
    status: 'succeeded',
    trigger: 'ui',
    logs: '$ docker compose up -d --remove-orphans\nContainer plex-app-1  Running\n',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    id: 2,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'e4f5g6h',
    envHash: 'def456',
    status: 'succeeded',
    trigger: 'git_push',
    logs: '$ docker compose up -d --remove-orphans\nContainer plex-app-1  Recreating\nContainer plex-app-1  Started\n',
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
  {
    id: 1,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'i7j8k9l',
    envHash: 'ghi789',
    status: 'failed',
    trigger: 'ui',
    logs: '$ docker compose up -d --remove-orphans\nError: image not found: plex:invalid-tag\n',
    createdAt: new Date(Date.now() - 172_800_000).toISOString(),
  },
];

export async function listStacks(): Promise<StackSummary[]> {
  return MOCK_STACKS;
}

export async function getStackDetail(opts: {
  data: { stackName: string };
}): Promise<StackDetail | null> {
  const stack = MOCK_STACKS.find((s) => s.name === opts.data.stackName);
  if (!stack) return null;

  return {
    name: stack.name,
    host: stack.host,
    syncStatus: stack.syncStatus,
    deployMode: stack.deployMode,
    composeContent: MOCK_COMPOSE,
    lastDeployCommitSha: 'a1b2c3d',
    currentCommitSha: 'x9y8z7w',
    variableNames: ['APP_IMAGE', 'APP_PORT', 'DATABASE_URL', 'SECRET_KEY'],
    icon: stack.icon,
  };
}

export async function triggerDeploy(_opts: {
  data: UIDeployRequest;
}): Promise<{ deployId: number }> {
  // Simulate a short delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { deployId: MOCK_DEPLOY_HISTORY.length + 1 };
}

export async function getDeployHistory(opts: {
  data: { stackName: string; limit?: number };
}): Promise<StackDeployRecord[]> {
  const limit = opts.data.limit ?? 20;
  return MOCK_DEPLOY_HISTORY
    .filter((d) => d.stack === opts.data.stackName)
    .slice(0, limit);
}

export async function saveComposeFile(_opts: {
  data: { stackName: string; content: string };
}): Promise<{ commitSha: string }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { commitSha: 'mock' + Date.now().toString(36) };
}

export async function updateStackIcon(_opts: {
  data: { stackName: string; iconSlug: string };
}): Promise<void> {
  // No-op in demo mode
}
