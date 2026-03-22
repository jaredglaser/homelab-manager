import type { StackSummary, StackDetail, StackDeployRecord, UIDeployRequest } from '@/types/stacks';

const mockComposeOverrides = new Map<string, string>();
const mockIconOverrides = new Map<string, string>();

const MOCK_STACKS: StackSummary[] = [
  {
    name: 'plex',
    host: 'homeserver',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 3600_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'plex',
  },
  {
    name: 'traefik',
    host: 'homeserver',
    syncStatus: 'pending',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 86400_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 2,
    icon: 'traefik',
  },
  {
    name: 'pihole',
    host: 'pihole-host',
    syncStatus: 'failed',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 7200_000).toISOString(),
    lastDeployStatus: 'failed',
    containerCount: 1,
    icon: 'pi-hole',
  },
  {
    name: 'homeassistant',
    host: 'homeserver',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 1800_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'home-assistant',
  },
  {
    name: 'grafana',
    host: 'homeserver',
    syncStatus: 'in_sync',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 43200_000).toISOString(),
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
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
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
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
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
    createdAt: new Date(Date.now() - 172800_000).toISOString(),
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

  const composeContent = mockComposeOverrides.get(stack.name) ?? MOCK_COMPOSE;
  return {
    name: stack.name,
    host: stack.host,
    syncStatus: stack.syncStatus,
    deployMode: stack.deployMode,
    composeContent,
    lastDeployCommitSha: 'a1b2c3d',
    currentCommitSha: 'x9y8z7w',
    variableNames: ['APP_IMAGE', 'APP_PORT', 'DATABASE_URL', 'SECRET_KEY'],
    icon: mockIconOverrides.get(stack.name) ?? stack.icon,
  };
}

export async function triggerDeploy(opts: {
  data: UIDeployRequest;
}): Promise<{ deployId: number }> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const newId = MOCK_DEPLOY_HISTORY.length + 1;
  MOCK_DEPLOY_HISTORY.unshift({
    id: newId,
    stack: opts.data.stack,
    host: opts.data.host,
    commitSha: 'mock' + Date.now().toString(36),
    envHash: '',
    status: 'succeeded',
    trigger: 'ui',
    logs: `$ docker compose ${opts.data.action === 'teardown' ? 'down' : 'up -d --remove-orphans'}\nDone.\n`,
    createdAt: new Date().toISOString(),
  });
  return { deployId: newId };
}

export async function getDeployHistory(opts: {
  data: { stackName: string; limit?: number };
}): Promise<StackDeployRecord[]> {
  const limit = opts.data.limit ?? 20;
  return MOCK_DEPLOY_HISTORY
    .filter((d) => d.stack === opts.data.stackName)
    .slice(0, limit);
}

export async function saveComposeFile(opts: {
  data: { stackName: string; content: string };
}): Promise<{ commitSha: string }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const commitSha = 'mock' + Date.now().toString(36);
  // Update mock compose content for subsequent getStackDetail reads
  mockComposeOverrides.set(opts.data.stackName, opts.data.content);
  return { commitSha };
}


export async function updateStackIcon(opts: {
  data: { stackName: string; iconSlug: string };
}): Promise<void> {
  const stack = MOCK_STACKS.find((s) => s.name === opts.data.stackName);
  if (stack) stack.icon = opts.data.iconSlug;
  mockIconOverrides.set(opts.data.stackName, opts.data.iconSlug);
}
