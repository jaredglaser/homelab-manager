import type { DatabaseClient } from '@/lib/clients/database-client';
import { isDockerManagementEnabled } from '@/lib/config/feature-flags';
import { HostRepository } from '@/lib/database/repositories/host-repository';

const DEV_HOST_NAME = 'localhost';
const DEV_AGENT_URL = 'http://localhost:9090';
const DEV_HEALTH_CHECK_URL = 'http://hlm-agent:9090';
const HEALTH_CHECK_ATTEMPTS = 5;
const HEALTH_CHECK_DELAY_MS = 2000;
const OPENBAO_RETRY_ATTEMPTS = 10;
const OPENBAO_RETRY_DELAY_MS = 2000;

/**
 * Auto-seed a localhost managed host for local development.
 * Gated by DEV_AGENT_TOKEN env var — never runs in production.
 * Idempotent: skips if any managed hosts already exist.
 */
export async function seedDevAgent(db: DatabaseClient): Promise<void> {
  const devToken = process.env.DEV_AGENT_TOKEN;
  if (!devToken) return;
  if (!isDockerManagementEnabled()) return;

  const hostRepo = new HostRepository(db.getPool());
  const existingHosts = await hostRepo.findAll();
  if (existingHosts.length > 0) {
    // Host exists — ensure token is stored and agent URL is up to date
    await ensureTokenStored(DEV_HOST_NAME, devToken);
    const devHost = existingHosts.find((h) => h.name === DEV_HOST_NAME);
    if (devHost && devHost.agent_url !== DEV_AGENT_URL) {
      await hostRepo.update(devHost.id, { agent_url: DEV_AGENT_URL });
      console.info(`[DevSeed] Updated agent URL from ${devHost.agent_url} to ${DEV_AGENT_URL}`);
    }
    return;
  }

  console.info('[DevSeed] Seeding localhost managed host for development');

  const host = await hostRepo.create({
    name: DEV_HOST_NAME,
    agent_url: DEV_AGENT_URL,
    capabilities: { docker: true },
  });

  // Store dev token in OpenBao (retries until OpenBao is ready)
  await ensureTokenStored(DEV_HOST_NAME, devToken);

  // Health check with retries — agent may still be starting
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

  console.info(`[DevSeed] Agent health check failed after ${HEALTH_CHECK_ATTEMPTS} attempts — host remains in "pending" status. Agent may start later.`);
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
    // OpenBao not ready or secret doesn't exist — proceed to store
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
