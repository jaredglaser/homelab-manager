import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';

import {
  generateAgentStackCompose,
  generateAgentStackEnv,
  type AgentStackConfig,
} from '../agent-stack-compose';

/* eslint-disable @typescript-eslint/no-explicit-any */
const parseYaml = (input: string) => load(input) as Record<string, any>;

const dockerOnlyConfig: AgentStackConfig = {
  agentToken: 'test-token-abc123',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  agentUpdaterImage: 'ghcr.io/jaredglaser/homelab-manager-agent-updater:latest',
  capabilities: { docker: true, zfs: false },
};

const zfsOnlyConfig: AgentStackConfig = {
  agentToken: 'test-token-zfs456',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:v1.0.0',
  agentUpdaterImage: 'ghcr.io/jaredglaser/homelab-manager-agent-updater:v1.0.0',
  capabilities: { docker: false, zfs: true },
  hlmZfsUid: 1100,
  hlmZfsGid: 1100,
};

const dockerZfsConfig: AgentStackConfig = {
  agentToken: 'test-token-both789',
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  agentUpdaterImage: 'ghcr.io/jaredglaser/homelab-manager-agent-updater:latest',
  capabilities: { docker: true, zfs: true },
  hlmZfsUid: 1100,
  hlmZfsGid: 1100,
  dockerGid: 999,
};

describe('generateAgentStackCompose', () => {
  it('generates correct YAML for Docker-only host', () => {
    const result = generateAgentStackCompose(dockerOnlyConfig);
    expect(result).toMatchSnapshot();
  });

  it('generates correct YAML for ZFS-only host', () => {
    const result = generateAgentStackCompose(zfsOnlyConfig);
    expect(result).toMatchSnapshot();
  });

  it('generates full stack YAML for Docker + ZFS host', () => {
    const result = generateAgentStackCompose(dockerZfsConfig);
    expect(result).toMatchSnapshot();
  });

  it('agent-internal network declared only when docker capability is enabled', () => {
    const dockerResult = generateAgentStackCompose(dockerOnlyConfig);
    const dockerParsed = parseYaml(dockerResult);
    expect(dockerParsed.networks['agent-internal']).toEqual({
      driver: 'bridge',
      internal: true,
    });

    const zfsResult = generateAgentStackCompose(zfsOnlyConfig);
    const zfsParsed = parseYaml(zfsResult);
    expect(zfsParsed.networks).toBeUndefined();
  });

  it('uses file-based token mount in all cases', () => {
    for (const config of [dockerOnlyConfig, zfsOnlyConfig, dockerZfsConfig]) {
      const result = generateAgentStackCompose(config);
      const parsed = parseYaml(result);
      expect(parsed.services.agent.environment.AGENT_TOKEN_FILE).toBe('/run/secrets/agent_token');
      expect(parsed.services.agent.volumes).toContain('./agent-token:/run/secrets/agent_token:ro');
      expect(parsed.services.agent.environment.AGENT_TOKEN).toBeUndefined();
    }
  });

  it('uses restart: unless-stopped for all services', () => {
    for (const config of [dockerOnlyConfig, zfsOnlyConfig, dockerZfsConfig]) {
      const result = generateAgentStackCompose(config);
      const parsed = parseYaml(result);
      for (const [, service] of Object.entries(
        parsed.services as Record<string, { restart: string }>
      )) {
        expect(service.restart).toBe('unless-stopped');
      }
    }
  });

  it('Docker-only: no ZFS mounts, no user config, has socket-proxy', () => {
    const result = generateAgentStackCompose(dockerOnlyConfig);
    const parsed = parseYaml(result);

    expect(parsed.services['socket-proxy']).toBeDefined();
    expect(parsed.services.agent.environment.DOCKER_HOST).toBe(
      'tcp://socket-proxy:2375'
    );
    expect(parsed.services.agent.depends_on).toContain('socket-proxy');

    expect(parsed.services.agent.user).toBeUndefined();
    expect(parsed.services.agent.group_add).toBeUndefined();
    // volumes only contains the token mount, no ZFS paths
    expect(parsed.services.agent.volumes).toEqual(['./agent-token:/run/secrets/agent_token:ro']);
  });

  it('ZFS-only: no socket-proxy, no DOCKER_HOST, has ZFS mounts + user', () => {
    const result = generateAgentStackCompose(zfsOnlyConfig);
    const parsed = parseYaml(result);

    expect(parsed.services['socket-proxy']).toBeUndefined();
    expect(parsed.services.agent.environment.DOCKER_HOST).toBeUndefined();
    expect(parsed.services.agent.depends_on).toBeUndefined();

    expect(parsed.services.agent.volumes).toEqual([
      './agent-token:/run/secrets/agent_token:ro',
      '/usr/sbin/zpool:/usr/sbin/zpool:ro',
      '/usr/sbin/zfs:/usr/sbin/zfs:ro',
      '/dev/zfs:/dev/zfs',
    ]);
    expect(parsed.services.agent.user).toBe('${HLM_ZFS_UID}:${HLM_ZFS_GID}');
  });

  it('Docker + ZFS: full stack with all features', () => {
    const result = generateAgentStackCompose(dockerZfsConfig);
    const parsed = parseYaml(result);

    expect(parsed.services['socket-proxy']).toBeDefined();
    expect(parsed.services.agent.environment.DOCKER_HOST).toBe(
      'tcp://socket-proxy:2375'
    );
    expect(parsed.services.agent.depends_on).toContain('socket-proxy');

    expect(parsed.services.agent.volumes).toEqual([
      './agent-token:/run/secrets/agent_token:ro',
      '/usr/sbin/zpool:/usr/sbin/zpool:ro',
      '/usr/sbin/zfs:/usr/sbin/zfs:ro',
      '/dev/zfs:/dev/zfs',
    ]);
    expect(parsed.services.agent.user).toBe('${HLM_ZFS_UID}:${HLM_ZFS_GID}');
    expect(parsed.services.agent.group_add).toEqual(['${DOCKER_GID}']);
  });

  it('agent-updater always mounts Docker socket directly', () => {
    for (const config of [dockerOnlyConfig, zfsOnlyConfig, dockerZfsConfig]) {
      const result = generateAgentStackCompose(config);
      const parsed = parseYaml(result);
      expect(parsed.services['agent-updater'].volumes).toContain(
        '/var/run/docker.sock:/var/run/docker.sock'
      );
    }
  });

  it('agent-updater is always included', () => {
    for (const config of [dockerOnlyConfig, zfsOnlyConfig, dockerZfsConfig]) {
      const result = generateAgentStackCompose(config);
      const parsed = parseYaml(result);
      expect(parsed.services['agent-updater']).toBeDefined();
    }
  });

  it('agent-internal network only present when docker capability', () => {
    const zfsResult = generateAgentStackCompose(zfsOnlyConfig);
    const zfsParsed = parseYaml(zfsResult);
    expect(zfsParsed.services.agent.networks).toBeUndefined();

    const dockerResult = generateAgentStackCompose(dockerOnlyConfig);
    const dockerParsed = parseYaml(dockerResult);
    expect(dockerParsed.services.agent.networks).toContain('agent-internal');
  });

  it('ZFS-only: top-level networks key is absent', () => {
    const result = generateAgentStackCompose(zfsOnlyConfig);
    const parsed = parseYaml(result);
    expect(parsed.networks).toBeUndefined();
  });

  it('neither docker nor zfs: minimal agent + updater only', () => {
    const noneConfig: AgentStackConfig = {
      agentToken: 'test-token-none',
      agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
      agentUpdaterImage: 'ghcr.io/jaredglaser/homelab-manager-agent-updater:latest',
      capabilities: { docker: false, zfs: false },
    };
    const result = generateAgentStackCompose(noneConfig);
    const parsed = parseYaml(result);
    expect(parsed.services['socket-proxy']).toBeUndefined();
    expect(parsed.services['agent']).toBeDefined();
    expect(parsed.services['agent-updater']).toBeDefined();
    expect(parsed.networks).toBeUndefined();
    expect(parsed.services.agent.networks).toBeUndefined();
    expect(parsed.services.agent.depends_on).toBeUndefined();
  });
});

describe('generateAgentStackEnv', () => {
  it('generates env for Docker-only host', () => {
    const result = generateAgentStackEnv(dockerOnlyConfig);
    expect(result).toMatchSnapshot();
  });

  it('generates env for ZFS-only host', () => {
    const result = generateAgentStackEnv(zfsOnlyConfig);
    expect(result).toMatchSnapshot();
  });

  it('generates env for Docker + ZFS host', () => {
    const result = generateAgentStackEnv(dockerZfsConfig);
    expect(result).toMatchSnapshot();
  });

  it('always includes images and port but not HLM_AGENT_TOKEN key', () => {
    for (const config of [dockerOnlyConfig, zfsOnlyConfig, dockerZfsConfig]) {
      const result = generateAgentStackEnv(config);
      expect(result).not.toContain('HLM_AGENT_TOKEN=');
      expect(result).toContain('AGENT_IMAGE=');
      expect(result).toContain('AGENT_UPDATER_IMAGE=');
      expect(result).toContain('HLM_AGENT_PORT=9090');
    }
  });

  it('does not include agent token in env output', () => {
    const result = generateAgentStackEnv(dockerOnlyConfig);
    expect(result).not.toContain('test-token-abc123');
  });

  it('includes ZFS UIDs only when zfs capability', () => {
    const dockerResult = generateAgentStackEnv(dockerOnlyConfig);
    expect(dockerResult).not.toContain('HLM_ZFS_UID');
    expect(dockerResult).not.toContain('HLM_ZFS_GID');

    const zfsResult = generateAgentStackEnv(zfsOnlyConfig);
    expect(zfsResult).toContain('HLM_ZFS_UID=1100');
    expect(zfsResult).toContain('HLM_ZFS_GID=1100');
  });

  it('includes DOCKER_GID only when both docker and zfs', () => {
    const dockerResult = generateAgentStackEnv(dockerOnlyConfig);
    expect(dockerResult).not.toContain('DOCKER_GID');

    const zfsResult = generateAgentStackEnv(zfsOnlyConfig);
    expect(zfsResult).not.toContain('DOCKER_GID');

    const bothResult = generateAgentStackEnv(dockerZfsConfig);
    expect(bothResult).toContain('DOCKER_GID=999');
  });

  it('throws when zfs is true but hlmZfsUid is missing', () => {
    const bad: AgentStackConfig = {
      agentToken: 'tok',
      agentImage: 'img',
      agentUpdaterImage: 'upd',
      capabilities: { docker: false, zfs: true },
      hlmZfsGid: 1100,
    };
    expect(() => generateAgentStackEnv(bad)).toThrow(
      'hlmZfsUid and hlmZfsGid are required when zfs capability is enabled'
    );
  });

  it('throws when zfs is true but hlmZfsGid is missing', () => {
    const bad: AgentStackConfig = {
      agentToken: 'tok',
      agentImage: 'img',
      agentUpdaterImage: 'upd',
      capabilities: { docker: false, zfs: true },
      hlmZfsUid: 1100,
    };
    expect(() => generateAgentStackEnv(bad)).toThrow(
      'hlmZfsUid and hlmZfsGid are required when zfs capability is enabled'
    );
  });

  it('throws when docker and zfs are true but dockerGid is missing', () => {
    const bad: AgentStackConfig = {
      agentToken: 'tok',
      agentImage: 'img',
      agentUpdaterImage: 'upd',
      capabilities: { docker: true, zfs: true },
      hlmZfsUid: 1100,
      hlmZfsGid: 1100,
    };
    expect(() => generateAgentStackEnv(bad)).toThrow(
      'dockerGid is required when both docker and zfs capabilities are enabled'
    );
  });

});
