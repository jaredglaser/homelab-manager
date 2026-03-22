import Dockerode from 'dockerode';
import { AgentUpdater } from './agent-updater';
import { parseInterval } from './parse-interval';

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

  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  const updater = new AgentUpdater(docker, {
    containerName,
    imageName,
    checkIntervalMs,
  });

  console.info(`Agent updater started — watching container '${containerName}' for image '${imageName}'`);
  console.info(`Check interval: ${intervalStr} (${checkIntervalMs}ms)`);

  while (true) {
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

    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }
}

main();
