import type { StackSummary, StackDetail, StackDeployRecord, UIDeployRequest, DeployStatus } from '@/types/stacks';

const MOCK_STACKS: StackSummary[] = [
  // nas01
  {
    name: 'traefik',
    host: 'nas01',
    syncStatus: 'pending',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 2, // traefik + nginx-proxy
    icon: 'traefik',
  },
  {
    name: 'plex',
    host: 'nas01',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'plex',
  },
  {
    name: 'homeassistant',
    host: 'nas01',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 1_800_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'home-assistant',
  },
  {
    name: 'monitoring',
    host: 'nas01',
    syncStatus: 'in_sync',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 43_200_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 2, // grafana + postgres
    icon: 'grafana',
  },
  // server02
  {
    name: 'jellyfin',
    host: 'server02',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 7_200_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'jellyfin',
  },
  {
    name: 'vaultwarden',
    host: 'server02',
    syncStatus: 'in_sync',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 10_800_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'vaultwarden',
  },
  {
    name: 'pihole',
    host: 'server02',
    syncStatus: 'failed',
    deployMode: 'auto',
    lastDeployAt: new Date(Date.now() - 7_200_000).toISOString(),
    lastDeployStatus: 'failed',
    containerCount: 1,
    icon: 'pi-hole',
  },
  {
    name: 'portainer',
    host: 'server02',
    syncStatus: 'in_sync',
    deployMode: 'manual',
    lastDeployAt: new Date(Date.now() - 21_600_000).toISOString(),
    lastDeployStatus: 'succeeded',
    containerCount: 1,
    icon: 'portainer',
  },
];

const MOCK_COMPOSE: Record<string, string> = {
  traefik: `services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - CF_DNS_API_TOKEN=\${CF_DNS_API_TOKEN}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik_data:/data
  nginx-proxy:
    image: nginx:latest
    restart: unless-stopped
    environment:
      - UPSTREAM_HOST=\${UPSTREAM_HOST}

volumes:
  traefik_data:
`,
  plex: `services:
  plex:
    image: plexinc/pms-docker:latest
    restart: unless-stopped
    network_mode: host
    environment:
      - PLEX_CLAIM=\${PLEX_CLAIM}
    volumes:
      - plex_config:/config
      - \${MEDIA_PATH}:/media

volumes:
  plex_config:
`,
  homeassistant: `services:
  homeassistant:
    image: homeassistant/home-assistant:stable
    restart: unless-stopped
    network_mode: host
    environment:
      - TZ=\${TZ}
    volumes:
      - ha_config:/config

volumes:
  ha_config:
`,
  monitoring: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=\${GF_SECURITY_ADMIN_PASSWORD}
      - GF_DATABASE_URL=\${GF_DATABASE_URL}
    volumes:
      - grafana_data:/var/lib/grafana
  postgres:
    image: timescale/timescaledb:latest-pg16
    restart: unless-stopped
    environment:
      - POSTGRES_PASSWORD=\${POSTGRES_PASSWORD}
      - POSTGRES_DB=\${POSTGRES_DB}
    volumes:
      - pg_data:/var/lib/postgresql/data

volumes:
  grafana_data:
  pg_data:
`,
  jellyfin: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports:
      - "8096:8096"
    environment:
      - JELLYFIN_PublishedServerUrl=\${JELLYFIN_PublishedServerUrl}
    volumes:
      - jellyfin_config:/config
      - \${MEDIA_PATH}:/media

volumes:
  jellyfin_config:
`,
  vaultwarden: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports:
      - "8080:80"
    environment:
      - ADMIN_TOKEN=\${ADMIN_TOKEN}
      - DATABASE_URL=\${DATABASE_URL}
    volumes:
      - vw_data:/data

volumes:
  vw_data:
`,
  pihole: `services:
  pihole:
    image: pihole/pihole:latest
    restart: unless-stopped
    ports:
      - "53:53/udp"
      - "8053:80"
    environment:
      - WEBPASSWORD=\${WEBPASSWORD}
      - TZ=\${TZ}
    volumes:
      - pihole_data:/etc/pihole

volumes:
  pihole_data:
`,
  portainer: `services:
  portainer:
    image: portainer/portainer-ce:latest
    restart: unless-stopped
    ports:
      - "9443:9443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - portainer_data:/data

volumes:
  portainer_data:
`,
};

const MOCK_DEPLOY_HISTORY: StackDeployRecord[] = [
  {
    id: 4,
    stack: 'plex',
    host: 'nas01',
    commitSha: 'b2c3d4e',
    envHash: 'jkl012',
    status: 'pending',
    trigger: 'git_push',
    action: 'deploy',
    forceRecreate: false,
    logs: null,
    createdAt: new Date(Date.now() - 3_600_000 / 2).toISOString(),
  },
  {
    id: 3,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'a1b2c3d',
    envHash: 'abc123',
    status: 'succeeded',
    trigger: 'ui',
    action: 'deploy',
    forceRecreate: false,
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
    action: 'deploy',
    forceRecreate: false,
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
    action: 'deploy',
    forceRecreate: false,
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

  const compose = MOCK_COMPOSE[stack.name] ?? '';
  const variableNames = Object.keys(MOCK_VARIABLE_VALUES[stack.name] ?? {});

  return {
    name: stack.name,
    host: stack.host,
    syncStatus: stack.syncStatus,
    deployMode: stack.deployMode,
    composeContent: compose,
    lastDeployCommitSha: 'a1b2c3d',
    currentCommitSha: stack.syncStatus === 'pending' ? 'x9y8z7w' : 'a1b2c3d',
    variableNames,
    icon: stack.icon,
  };
}

export async function triggerDeploy(_opts: {
  data: UIDeployRequest;
}): Promise<{ deployId: number; status: DeployStatus; logs: string }> {
  // Simulate a short delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { deployId: MOCK_DEPLOY_HISTORY.length + 1, status: 'succeeded', logs: '' };
}

export async function resumeDeploy(opts: {
  data: { deployId: number };
}): Promise<{ deployId: number; status: DeployStatus; logs: string }> {
  return { deployId: opts.data.deployId, status: 'succeeded', logs: '' };
}

export async function rejectDeploy(opts: {
  data: { deployId: number };
}): Promise<{ deployId: number }> {
  return { deployId: opts.data.deployId };
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

export async function getStackVariables(opts: {
  data: { stackName: string };
}): Promise<string[]> {
  return Object.keys(MOCK_VARIABLE_VALUES[opts.data.stackName] ?? {});
}

const MOCK_VARIABLE_VALUES: Record<string, Record<string, string>> = {
  traefik: {
    CF_DNS_API_TOKEN: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    UPSTREAM_HOST: 'nas01.lan',
  },
  plex: {
    PLEX_CLAIM: 'claim-xxxxxxxxxxxxxxxxxxxx',
    MEDIA_PATH: '/mnt/media',
  },
  homeassistant: {
    TZ: 'America/Chicago',
  },
  monitoring: {
    GF_SECURITY_ADMIN_PASSWORD: 'grafana-adm1n!',
    GF_DATABASE_URL: 'postgres://grafana:s3cr3t@postgres:5432/grafana',
    POSTGRES_PASSWORD: 's3cr3t',
    POSTGRES_DB: 'grafana',
  },
  jellyfin: {
    JELLYFIN_PublishedServerUrl: 'https://jellyfin.nas01.lan',
    MEDIA_PATH: '/mnt/media',
  },
  vaultwarden: {
    ADMIN_TOKEN: 'a3f8c1d2e4b7690f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f',
    DATABASE_URL: 'postgresql://vw:s3cr3t@db:5432/vaultwarden',
  },
  pihole: {
    WEBPASSWORD: 'pihole-adm1n!',
    TZ: 'America/Chicago',
  },
  portainer: {},
};

export async function getVariableValue(opts: {
  data: { stackName: string; variableName: string };
}): Promise<string | null> {
  return MOCK_VARIABLE_VALUES[opts.data.stackName]?.[opts.data.variableName] ?? '';
}

export async function getStackVariableValues(opts: {
  data: { stackName: string };
}): Promise<Record<string, string>> {
  return MOCK_VARIABLE_VALUES[opts.data.stackName] ?? {};
}

export async function setVariableValue(_opts: {
  data: { stackName: string; variableName: string; value: string };
}): Promise<void> {
  // No-op in demo mode
}

export async function deleteVariable(_opts: {
  data: { stackName: string; variableName: string };
}): Promise<void> {
  // No-op in demo mode
}

export async function listManagedHostNames(): Promise<string[]> {
  return [...new Set(MOCK_STACKS.map((s) => s.host))];
}

export async function createStack(_opts: {
  data: { stackName: string; host: string; autoDeploy: boolean };
}): Promise<{ commitSha: string }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { commitSha: 'mock' + Date.now().toString(36) };
}

export async function deleteStack(_opts: {
  data: { stackName: string; teardown: boolean };
}): Promise<{ commitSha: string }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { commitSha: 'mock' + Date.now().toString(36) };
}

export async function updateStackSettings(_opts: {
  data: { stackName: string; host: string; autoDeploy: boolean };
}): Promise<{ commitSha: string }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { commitSha: 'mock' + Date.now().toString(36) };
}

export async function ensureVariablesExist(_opts: {
  data: { stackName: string; variableNames: string[] };
}): Promise<void> {
  // No-op in demo mode
}

export async function controlStack(_opts: {
  data:
    | { host: string; stack: string; action: 'start' | 'stop' | 'restart'; scope: 'stack' }
    | {
        host: string;
        stack: string;
        action: 'start' | 'stop' | 'restart';
        scope: 'service';
        service: string;
      };
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}
