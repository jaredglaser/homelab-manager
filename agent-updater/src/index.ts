import Dockerode from 'dockerode';
import { AgentUpdater } from './agent-updater';
import { HealthReporter } from './health-reporter';
import { parseInterval } from './parse-interval';
import { parseAutoUpdate, AUTO_UPDATE_ENV } from './parse-auto-update';
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
  const intervalStr = process.env.HLM_CHECK_INTERVAL || '6h';

  if (!imageName) {
    console.error('HLM_WATCH_IMAGE environment variable is required');
    process.exit(1);
  }

  let checkIntervalMs: number;
  try {
    checkIntervalMs = parseInterval(intervalStr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const agentUrl = process.env.HLM_AGENT_URL || 'http://localhost:9090';
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  const healthReporter = new HealthReporter(agentUrl);

  // Manual by default: unless the operator explicitly opted this agent in,
  // the updater must never check for or apply updates on its own.
  const autoUpdateRaw = process.env[AUTO_UPDATE_ENV];
  const autoUpdate = parseAutoUpdate(autoUpdateRaw);
  if (autoUpdate === null) {
    console.error(`Invalid ${AUTO_UPDATE_ENV} value: '${autoUpdateRaw}'. Must be 'true' or 'false'.`);
    process.exit(1);
  }

  const updater = new AgentUpdater(docker, {
    containerName,
    imageName,
    checkIntervalMs,
  }, healthReporter);

  console.info(`Agent updater started, watching container '${containerName}' for image '${imageName}'`);
  console.info(`Check interval: ${intervalStr} (${checkIntervalMs}ms)`);
  if (!autoUpdate) {
    console.info('Automatic updates are disabled for this agent (manual by default). Set HLM_AUTO_UPDATE=true to opt in.');
  }

  const triggerPort = parseTriggerPort(process.env.HLM_TRIGGER_PORT);
  if (triggerPort === null) {
    console.error(`Invalid HLM_TRIGGER_PORT value: '${process.env.HLM_TRIGGER_PORT}'. Must be an integer between 0 and 65535.`);
    process.exit(1);
  }
  if (triggerPort > 0) {
    startTriggerServer(updater, triggerPort);
  }

  let shutdownRequested = false;

  function requestShutdown(): void {
    console.info('Shutdown signal received, finishing current cycle...');
    shutdownRequested = true;
  }

  process.on('SIGINT', requestShutdown);
  process.on('SIGTERM', requestShutdown);

  while (!shutdownRequested) {
    if (autoUpdate) {
      try {
        const check = await updater.checkForUpdate();

        if (check.updateAvailable) {
          console.info(`Update available: ${check.currentDigest} → ${check.remoteDigest}`);
          const result = await updater.performUpdate();

          if (result.success) {
            console.info(`Update completed: ${result.previousImage} → ${result.newImage}`);
          } else {
            console.error(`Update failed: ${result.error}${result.rolledBack ? ' (rolled back)' : ''}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Update check error: ${message}`);
      }
    }

    if (shutdownRequested) break;

    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }

  console.info('Agent updater shut down gracefully');
}

main();
