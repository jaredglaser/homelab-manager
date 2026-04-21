import type { DatabaseClient } from '@/lib/clients/database-client';
import { HostRepository } from '@/lib/database/repositories/host-repository';

const DEV_AGENT_URL = 'http://localhost:9090';
const DEV_HEALTH_CHECK_URL = 'http://hlm-agent:9090';
const DEV_DEFAULT_HOST_NAME = 'localhost';
const HEALTH_CHECK_ATTEMPTS = 5;
const HEALTH_CHECK_DELAY_MS = 2000;
const OPENBAO_RETRY_ATTEMPTS = 10;
const OPENBAO_RETRY_DELAY_MS = 2000;

/**
 * Resolve the dev host name from DEV_HOST_NAME env var,
 * falling back to "localhost" so a natural manifest entry works out of the box.
 */
function getDevHostName(): string {
  return process.env.DEV_HOST_NAME || DEV_DEFAULT_HOST_NAME;
}

/**
 * Auto-seed a managed host for local development.
 * Uses the first Docker config host name so entity IDs align.
 * Gated by DEV_AGENT_TOKEN env var: never runs in production.
 * Idempotent: skips if any managed hosts already exist.
 */
export async function seedDevAgent(db: DatabaseClient): Promise<void> {
  const devToken = process.env.DEV_AGENT_TOKEN;
  if (!devToken) return;

  const devHostName = getDevHostName();
  const hostRepo = new HostRepository(db.getPool());
  const existingHosts = await hostRepo.findAll();
  if (existingHosts.length > 0) {
    // A managed host was found; ensure dev host token is stored and agent URL is up to date
    await ensureTokenStored(devHostName, devToken);
    const devHost = existingHosts.find((h) => h.name === devHostName);
    if (devHost && devHost.agentUrl !== DEV_AGENT_URL) {
      await hostRepo.update(devHost.id, { agentUrl: DEV_AGENT_URL });
      console.info(`[DevSeed] Updated agent URL from ${devHost.agentUrl} to ${DEV_AGENT_URL}`);
    }
    return;
  }

  console.info(`[DevSeed] Seeding managed host "${devHostName}" for development`);

  const host = await hostRepo.create({
    name: devHostName,
    agentUrl: DEV_AGENT_URL,
    capabilities: { docker: true },
  });

  // Store dev token in OpenBao (retries until OpenBao is ready)
  await ensureTokenStored(devHostName, devToken);

  // Health check with retries; agent may still be starting
  for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${DEV_HEALTH_CHECK_URL}/health`);
      if (response.ok) {
        await hostRepo.updateStatus(host.id, 'healthy');
        console.info(`[DevSeed] Agent health check passed (attempt ${attempt}/${HEALTH_CHECK_ATTEMPTS})`);
        return;
      }
    } catch {
      // Agent not ready yet
    }

    if (attempt < HEALTH_CHECK_ATTEMPTS) {
      console.info(`[DevSeed] Agent not ready, retrying in ${HEALTH_CHECK_DELAY_MS}ms (attempt ${attempt}/${HEALTH_CHECK_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_DELAY_MS));
    }
  }

  console.info(`[DevSeed] Agent health check failed after ${HEALTH_CHECK_ATTEMPTS} attempts; host remains in "pending" status. Agent may start later.`);
}

/**
 * Ensure the dev agent token is stored in OpenBao with retries.
 * OpenBao may not be ready when the worker starts, so we retry.
 */
async function ensureTokenStored(hostname: string, token: string): Promise<void> {
  const { loadOpenBaoConfig, isOpenBaoConfigured } = await import('@/lib/config/openbao-config');
  if (!isOpenBaoConfigured()) {
    console.info('[DevSeed] OpenBao not configured, skipping token storage');
    return;
  }

  const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
  const baoConfig = loadOpenBaoConfig();
  const baoClient = new OpenBaoClient(baoConfig);

  // Check if token already exists
  try {
    const existing = await baoClient.getHostSecret(hostname, 'agent_token');
    if (existing === token) {
      return;
    }
  } catch {
    // OpenBao not ready or secret doesn't exist; proceed to store
  }

  for (let attempt = 1; attempt <= OPENBAO_RETRY_ATTEMPTS; attempt++) {
    try {
      await baoClient.ensureSecretsEngine();
      await baoClient.setHostSecret(hostname, 'agent_token', token);
      console.info(`[DevSeed] Stored dev agent token in OpenBao (attempt ${attempt}/${OPENBAO_RETRY_ATTEMPTS})`);
      return;
    } catch (err) {
      if (attempt < OPENBAO_RETRY_ATTEMPTS) {
        console.info(`[DevSeed] OpenBao not ready, retrying in ${OPENBAO_RETRY_DELAY_MS}ms (attempt ${attempt}/${OPENBAO_RETRY_ATTEMPTS})`);
        await new Promise((resolve) => setTimeout(resolve, OPENBAO_RETRY_DELAY_MS));
      } else {
        console.error('[DevSeed] Failed to store token in OpenBao after all retries:', err instanceof Error ? err.message : err);
      }
    }
  }
}
