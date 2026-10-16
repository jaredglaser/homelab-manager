import Dockerode from 'dockerode';
import { AgentUpdater } from './agent-updater';
import { HealthReporter } from './health-reporter';
import { createTriggerHandler, createTriggerState, repoPrefix } from './trigger-server';

function parseTriggerPort(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 9091;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

function startTriggerServer(updater: AgentUpdater, port: number, token: string | undefined, watchedRepoPrefix: string | undefined, selfRepoPrefix: string | undefined): void {
  Bun.serve({
    port,
    fetch: createTriggerHandler(updater, createTriggerState(), { token, watchedRepoPrefix, selfRepoPrefix }),
  });
  console.info(`Manual update trigger server listening on port ${port}`);
  if (!token) {
    console.error('HLM_TRIGGER_TOKEN is not set: the trigger endpoint rejects every request until the stack is regenerated with a token.');
  }
}

async function main(): Promise<void> {
  const containerName = process.env.HLM_WATCH_CONTAINER || 'hlm-agent';
  const selfContainerName = process.env.HLM_SELF_CONTAINER || 'hlm-agent-updater';
  const imageName = process.env.HLM_WATCH_IMAGE;
  const selfImageName = process.env.HLM_SELF_IMAGE;

  if (!imageName) {
    console.error('HLM_WATCH_IMAGE environment variable is required');
    process.exit(1);
  }

  const agentUrl = process.env.HLM_AGENT_URL || 'http://localhost:9090';
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  const healthReporter = new HealthReporter(agentUrl);

  const triggerPort = parseTriggerPort(process.env.HLM_TRIGGER_PORT);
  if (triggerPort === null) {
    console.error(`Invalid HLM_TRIGGER_PORT value: '${process.env.HLM_TRIGGER_PORT}'. Must be an integer between 0 and 65535.`);
    process.exit(1);
  }

  const updater = new AgentUpdater(docker, {
    containerName,
    selfContainerName,
    imageName,
    selfTriggerPort: triggerPort > 0 ? triggerPort : undefined,
  }, healthReporter);

  console.info(`Agent updater started, watching container '${containerName}' for image '${imageName}'`);
  console.info('Updates are manual only: the manager triggers them via the agent relay.');

  if (triggerPort > 0) {
    startTriggerServer(updater, triggerPort, process.env.HLM_TRIGGER_TOKEN, repoPrefix(imageName), selfImageName ? repoPrefix(selfImageName) : undefined);
  } else {
    console.info('Trigger server disabled (HLM_TRIGGER_PORT=0); exiting.');
    return;
  }

  // Fire and forget: a leftover only lingers if this cleanup never runs, and
  // startup must not wait on docker for the trigger endpoint to come up.
  void updater.removeRetiredSelf().catch((error: unknown) => {
    console.error(`Retired sidecar cleanup failed: ${error instanceof Error ? error.message : error}`);
  });

  // Nothing runs on a schedule: the process exists to serve the manual trigger
  // endpoint, so it just parks until a shutdown signal arrives.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  console.info('Agent updater shut down gracefully');
}

main();
