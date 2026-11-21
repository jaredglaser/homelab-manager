import Dockerode from 'dockerode';
import { runAgentHandover } from './lib/self-update';

// One-shot entrypoint of the ephemeral update helper container: it must outlive the agent container it stops, so it runs as its own container.
const targetImage = process.env.HLM_UPDATE_TARGET_IMAGE;
const containerName = process.env.HLM_UPDATE_CONTAINER ?? 'hlm-agent';
const agentPort = Number(process.env.HLM_UPDATE_AGENT_PORT ?? 9090);

if (!targetImage) {
  console.error('HLM_UPDATE_TARGET_IMAGE is required');
  process.exit(1);
}

const docker = new Dockerode();

try {
  const result = await runAgentHandover(docker, { containerName, targetImage, agentPort });
  if (result.rolledBack) {
    console.error('Agent update failed and was rolled back to the previous image');
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(
    'Agent update failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
