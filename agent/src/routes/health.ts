import type Dockerode from 'dockerode';
import type { AgentImageInfo } from '../lib/agent-image';
// CI stamps AGENT_VERSION from the release tag at image build time. Local dev
// falls back to the short commit hash, matching what non-tag CI images report.
let gitRevision: string | undefined;

function readGitRevision(): string | undefined {
  try {
    const { stdout, exitCode } = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']);
    if (exitCode === 0) return stdout.toString().trim();
  } catch {
    // No git binary or repo (e.g. running outside a checkout)
  }
  return undefined;
}

const resolveAgentVersion = (): string => {
  if (process.env.AGENT_VERSION) return process.env.AGENT_VERSION;
  // HEAD cannot move under a running process, so spawn git once rather than per /info request.
  gitRevision ??= readGitRevision();
  return gitRevision ?? 'dev';
};

interface DockerCapability {
  available: boolean;
  version?: string;
  apiVersion?: string;
}

/**
 * Query the Docker daemon for its version info and return a capability object.
 */
async function getDockerCapability(
  docker: Dockerode
): Promise<DockerCapability> {
  try {
    const dockerVersion = await docker.version();
    return {
      available: true,
      version: dockerVersion.Version,
      apiVersion: dockerVersion.ApiVersion,
    };
  } catch {
    return { available: false };
  }
}

async function checkHealthy(
  docker: Dockerode | null,
): Promise<{ dockerCapability: DockerCapability; isHealthy: boolean }> {
  const dockerCapability = docker
    ? await getDockerCapability(docker)
    : { available: false };
  return { dockerCapability, isHealthy: dockerCapability.available };
}

/**
 * Liveness check for the unauthenticated /health endpoint. Returns only the
 * status field: this endpoint bypasses auth, so it must not expose version or
 * capability detail to unauthenticated callers. Use /info (authenticated) for
 * version and capability data.
 *
 * @param docker - Dockerode client, or null when Docker is not configured
 * @returns 200 with status healthy, or 503 with status unhealthy
 */
export async function handleHealth(
  docker: Dockerode | null,
): Promise<Response> {
  const { isHealthy } = await checkHealthy(docker);
  return Response.json(
    { status: isHealthy ? 'healthy' : 'unhealthy' },
    { status: isHealthy ? 200 : 503 }
  );
}

/**
 * Detailed agent info for the authenticated /info endpoint: agent version plus
 * Docker capability detail.
 *
 * @param docker - Dockerode client, or null when Docker is not configured
 * @param resolveImage - Lazy resolver for this agent's image; null fields mean undetermined
 * @returns An HTTP Response whose JSON body includes status, agentVersion, agent image, and capabilities
 */
export async function handleInfo(
  docker: Dockerode | null,
  resolveImage?: () => Promise<AgentImageInfo>,
  resolveDigest?: () => Promise<string | null>
): Promise<Response> {
  const { dockerCapability, isHealthy } = await checkHealthy(docker);
  const agentImage = await resolveImage?.();
  const agentImageDigest = await resolveDigest?.();

  return Response.json(
    {
      status: isHealthy ? 'healthy' : 'unhealthy',
      agentVersion: resolveAgentVersion(),
      agentImage: agentImage?.image ?? null,
      agentImageTag: agentImage?.tag ?? null,
      agentImageDigest: agentImageDigest ?? null,
      capabilities: {
        docker: dockerCapability,
      },
    },
    { status: isHealthy ? 200 : 503 }
  );
}
