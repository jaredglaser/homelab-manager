import Dockerode from 'dockerode';
import { AgentUpdater } from './agent-updater';
import { HealthReporter } from './health-reporter';
import { createTriggerHandler, createTriggerState } from './trigger-server';

function parseTriggerPort(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 9091;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

function startTriggerServer(updater: AgentUpdater, port: number): void {
  Bun.serve({
    port,
    fetch: createTriggerHandler(updater, createTriggerState()),
  });
  console.info(`Manual update trigger server listening on port ${port}`);
}

async function main(): Promise<void> {
  const containerName = process.env.HLM_WATCH_CONTAINER || 'hlm-agent';
  const imageName = process.env.HLM_WATCH_IMAGE;

  if (!imageName) {
    console.error('HLM_WATCH_IMAGE environment variable is required');
    process.exit(1);
  }

  const agentUrl = process.env.HLM_AGENT_URL || 'http://localhost:9090';
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  const healthReporter = new HealthReporter(agentUrl);

  const updater = new AgentUpdater(docker, {
    containerName,
    imageName,
  }, healthReporter);

  console.info(`Agent updater started, watching container '${containerName}' for image '${imageName}'`);
  console.info('Updates are manual only: the manager triggers them via the agent relay.');

  const triggerPort = parseTriggerPort(process.env.HLM_TRIGGER_PORT);
  if (triggerPort === null) {
    console.error(`Invalid HLM_TRIGGER_PORT value: '${process.env.HLM_TRIGGER_PORT}'. Must be an integer between 0 and 65535.`);
    process.exit(1);
  }
  if (triggerPort > 0) {
    startTriggerServer(updater, triggerPort);
  } else {
    console.info('Trigger server disabled (HLM_TRIGGER_PORT=0); exiting.');
    return;
  }

  // Nothing runs on a schedule: the process exists to serve the manual trigger
  // endpoint, so it just parks until a shutdown signal arrives.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  console.info('Agent updater shut down gracefully');
}

main();
