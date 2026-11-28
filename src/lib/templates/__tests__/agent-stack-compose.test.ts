import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';

import {
  generateAgentStackCompose,
  generateAgentStackEnv,
  type AgentStackConfig,
} from '../agent-stack-compose';

/* eslint-disable @typescript-eslint/no-explicit-any */
const parseYaml = (input: string) => load(input) as Record<string, any>;

const MOCK_PUBKEY = '{"kty":"OKP","crv":"Ed25519","x":"test-x-value"}';

const dockerOnlyConfig: AgentStackConfig = {
  hostName: 'test-host',
  agentTrustedPubkey: MOCK_PUBKEY,
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
  capabilities: { docker: true },
};

const noDockerConfig: AgentStackConfig = {
  hostName: 'test-host',
  agentTrustedPubkey: MOCK_PUBKEY,
  agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:v1.0.0',
  capabilities: { docker: false },
};

describe('generateAgentStackCompose', () => {
  it('generates correct YAML for Docker-only host', () => {
    const result = generateAgentStackCompose(dockerOnlyConfig);
    expect(result).toMatchSnapshot();
  });

  it('agent networks declared only when docker capability is enabled', () => {
    const dockerResult = generateAgentStackCompose(dockerOnlyConfig);
    const dockerParsed = parseYaml(dockerResult);
    expect(dockerParsed.networks['agent-internal']).toEqual({
      driver: 'bridge',
      internal: true,
    });
    // agent-public must be a non-internal bridge: an internal-only network
    // breaks the published port (host->container DNAT has no path).
    expect(dockerParsed.networks['agent-public']).toEqual({
      driver: 'bridge',
    });

    const noDockerParsed = parseYaml(generateAgentStackCompose(noDockerConfig));
    expect(noDockerParsed.networks).toBeUndefined();
  });

  it('references AGENT_TRUSTED_PUBKEY from the .env in all cases, without embedding the key', () => {
    for (const config of [dockerOnlyConfig, noDockerConfig]) {
      const result = generateAgentStackCompose(config);
      const parsed = parseYaml(result);
      expect(parsed.services.agent.environment.AGENT_TRUSTED_PUBKEY).toBe('${AGENT_TRUSTED_PUBKEY}');
      expect(result).not.toContain('kty');
      expect(parsed.services.agent.environment.AGENT_HOST_NAME).toBe('test-host');
      expect(parsed.services.agent.environment.AGENT_TOKEN_FILE).toBeUndefined();
      expect(parsed.services.agent.environment.AGENT_TOKEN).toBeUndefined();
    }
  });

  it('passes AGENT_IMAGE through so the agent can report its own tag', () => {
    for (const config of [dockerOnlyConfig, noDockerConfig]) {
      const parsed = parseYaml(generateAgentStackCompose(config));
      expect(parsed.services.agent.environment.AGENT_IMAGE).toBe('${AGENT_IMAGE}');
    }
  });

  it('uses restart: unless-stopped for every long-running service', () => {
    for (const config of [dockerOnlyConfig, noDockerConfig]) {
      const result = generateAgentStackCompose(config);
      const parsed = parseYaml(result);
      for (const [name, service] of Object.entries(
        parsed.services as Record<string, { restart: string }>
      )) {
        expect(service.restart).toBe(name === 'stacks-dir-init' ? 'no' : 'unless-stopped');
      }
    }
  });

  it('gives the agent access to the stacks dir only when it lacks it, before the agent starts', () => {
    const cases: [AgentStackConfig, string, string][] = [
      [dockerOnlyConfig, 'agent:agent', 'setpriv --reuid=agent --regid=agent --clear-groups'],
      [noDockerConfig, 'agent:agent', 'setpriv --reuid=agent --regid=agent --clear-groups'],
    ];
    for (const [config, owner, asAgent] of cases) {
      const parsed = parseYaml(generateAgentStackCompose(config));
      const init = parsed.services['stacks-dir-init'];
      expect(init.image).toBe('${AGENT_IMAGE}');
      expect(init.user).toBe('0:0');
      expect(init.network_mode).toBe('none');
      expect(init.working_dir).toBe('/opt/homelab-manager/stacks');
      expect(init.labels).toEqual(['hlm.managed=true', 'hlm.role=agent-init']);
      expect(init.volumes).toEqual([stacksMount]);
      const script: string = init.entrypoint[2];
      expect(script).toStartWith(`can_use() { ${asAgent} test -r "$$1" -a -w "$$1" -a -x "$$1"; }\n`);
      expect(script).toContain(`if ! can_use .; then\n  chown ${owner} . && chmod u+rwx . || warn `);
      expect(script).toContain(
        `if [ -d hlm-agent-tls ] && ! can_use hlm-agent-tls; then\n  chown -R ${owner} hlm-agent-tls && chmod u+rwx hlm-agent-tls || warn `,
      );
      expect(script).not.toContain(`chown -R ${owner} . `);
      expect(script).toEndWith('\nexit 0\n');
      expect(parsed.services.agent.depends_on['stacks-dir-init']).toEqual({
        condition: 'service_completed_successfully',
      });
    }
  });

  const stacksMount =
    '${HLM_STACKS_DIR:-/opt/homelab-manager/stacks}:/opt/homelab-manager/stacks';

  it('Docker host: no host mounts beyond the stacks dir, no user config, has socket-proxy', () => {
    const result = generateAgentStackCompose(dockerOnlyConfig);
    const parsed = parseYaml(result);

    expect(parsed.services['socket-proxy']).toBeDefined();
    expect(parsed.services.agent.environment.DOCKER_HOST).toBe(
      'tcp://socket-proxy:2375'
    );
    expect(parsed.services.agent.depends_on['socket-proxy']).toEqual({ condition: 'service_started' });

    expect(parsed.services.agent.user).toBeUndefined();
    expect(parsed.services.agent.group_add).toBeUndefined();
    expect(parsed.services.agent.volumes).toEqual([stacksMount]);
  });

  it('agent mounts the stacks dir so files survive container recreation', () => {
    for (const config of [dockerOnlyConfig, noDockerConfig]) {
      const parsed = parseYaml(generateAgentStackCompose(config));
      expect(parsed.services.agent.volumes).toContain(stacksMount);
    }
  });

  it('generates the agent and its stacks-dir init, plus the socket proxy for docker hosts', () => {
    const dockerParsed = parseYaml(generateAgentStackCompose(dockerOnlyConfig));
    expect(Object.keys(dockerParsed.services).sort()).toEqual(['agent', 'socket-proxy', 'stacks-dir-init']);

    const noDockerParsed = parseYaml(generateAgentStackCompose(noDockerConfig));
    expect(Object.keys(noDockerParsed.services).sort()).toEqual(['agent', 'stacks-dir-init']);
  });

  it('agent gets TLS env, ca trust, and an https healthcheck override', () => {
    const result = generateAgentStackCompose(dockerOnlyConfig);
    const parsed = parseYaml(result);
    const agent = parsed.services['agent'];
    expect(agent.container_name).toBe('hlm-agent');
    expect(agent.environment.AGENT_CONTAINER_NAME).toBe('hlm-agent');
    expect(agent.environment.TLS_CERT_PATH).toBe('/opt/homelab-manager/stacks/hlm-agent-tls/cert.pem');
    expect(agent.environment.TLS_KEY_PATH).toBe('/opt/homelab-manager/stacks/hlm-agent-tls/key.pem');
    expect(agent.environment.NODE_EXTRA_CA_CERTS).toBe('/opt/homelab-manager/stacks/hlm-agent-tls/cert.pem');
    expect(agent.healthcheck.test[0]).toBe('CMD-SHELL');
    expect(agent.healthcheck.test[1]).toContain("fetch('https://localhost:'");
  });

  it('TLS paths never vary with the host name', () => {
    for (const config of [dockerOnlyConfig, noDockerConfig]) {
      const parsed = parseYaml(generateAgentStackCompose(config));
      const agent = parsed.services['agent'];
      expect(agent.environment.TLS_CERT_PATH).toBe('/opt/homelab-manager/stacks/hlm-agent-tls/cert.pem');
      expect(agent.environment.TLS_KEY_PATH).toBe('/opt/homelab-manager/stacks/hlm-agent-tls/key.pem');
    }
  });

  it('agent attached to both internal and public networks when docker capability', () => {
    const noDockerParsed = parseYaml(generateAgentStackCompose(noDockerConfig));
    expect(noDockerParsed.services.agent.networks).toBeUndefined();

    const dockerResult = generateAgentStackCompose(dockerOnlyConfig);
    const dockerParsed = parseYaml(dockerResult);
    expect(dockerParsed.services.agent.networks).toContain('agent-internal');
    expect(dockerParsed.services.agent.networks).toContain('agent-public');
  });

  it('no docker: minimal agent only', () => {
    const result = generateAgentStackCompose(noDockerConfig);
    const parsed = parseYaml(result);
    expect(parsed.services['socket-proxy']).toBeUndefined();
    expect(parsed.services['agent']).toBeDefined();
    expect(parsed.networks).toBeUndefined();
    expect(parsed.services.agent.networks).toBeUndefined();
    expect(Object.keys(parsed.services.agent.depends_on)).toEqual(['stacks-dir-init']);
  });
});

describe('generateAgentStackEnv', () => {
  it('generates env for Docker-only host', () => {
    const result = generateAgentStackEnv(dockerOnlyConfig);
    expect(result).toMatchSnapshot();
  });

  it('always includes images and port but not HLM_AGENT_TOKEN key', () => {
    for (const config of [dockerOnlyConfig, noDockerConfig]) {
      const result = generateAgentStackEnv(config);
      expect(result).not.toContain('HLM_AGENT_TOKEN=');
      expect(result).toContain('AGENT_IMAGE=');
      expect(result).toContain('HLM_AGENT_PORT=9090');
      expect(result).toContain('HLM_STACKS_DIR=/opt/homelab-manager/stacks');
    }
  });

  it('does not include agent token in env output', () => {
    const result = generateAgentStackEnv(dockerOnlyConfig);
    expect(result).not.toContain('AGENT_TOKEN');
  });

  it('generates exactly the documented env lines for a docker host', () => {
    const result = generateAgentStackEnv(dockerOnlyConfig);
    expect(result).toBe(
      [
        `AGENT_IMAGE=${dockerOnlyConfig.agentImage}`,
        'HLM_AGENT_PORT=9090',
        'HLM_STACKS_DIR=/opt/homelab-manager/stacks',
        `AGENT_TRUSTED_PUBKEY=${MOCK_PUBKEY}`,
      ].join('\n') + '\n',
    );
  });
});
