import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JWK } from 'jose';
import type { DatabaseClient } from '@/lib/clients/database-client';
import { HostRepository } from '@/lib/database/repositories/host-repository';
import { AgentKeypairsRepository } from '@/lib/database/repositories/agent-keypairs-repository';
import { loadMasterKeyring } from '@/lib/crypto/master-key';

const DEV_AGENT_URL = 'http://localhost:9090';
const DEV_HEALTH_CHECK_URL = 'http://hlm-agent:9090';
/** Reaches the dev box from inside the ansible-sidecar container, which docker-compose gives a host-gateway alias. */
const DEV_SSH_HOST = 'host.docker.internal';
const DEV_DEFAULT_HOST_NAME = 'localhost';
const DEFAULT_PUBKEY_FILE = process.env.DEV_AGENT_PUBKEY_FILE || './data/dev-agent-pubkey.json';
const HEALTH_CHECK_ATTEMPTS = 5;
const HEALTH_CHECK_DELAY_MS = 2000;

function getDevHostName(): string {
  return process.env.DEV_HOST_NAME || DEV_DEFAULT_HOST_NAME;
}

/**
 * Auto-seed a managed host + agent keypair for local development.
 * Gated by HOMELAB_DEV_SEED=true; never runs in production. Idempotent.
 *
 * On first run: generates an Ed25519 keypair, stores the private JWK encrypted
 * in agent_keypairs, writes the public JWK to DEFAULT_PUBKEY_FILE so the agent
 * container can read it via AGENT_TRUSTED_PUBKEY_FILE.
 */
export async function seedDevAgent(db: DatabaseClient): Promise<void> {
  if (process.env.HOMELAB_DEV_SEED !== 'true') return;

  const devHostName = getDevHostName();
  const pool = db.getPool();
  const hostRepo = new HostRepository(pool);
  const keyring = await loadMasterKeyring();
  const keypairs = new AgentKeypairsRepository(pool, keyring);

  const existing = await hostRepo.findAll();
  let host = existing.find((h) => h.name === devHostName) ?? null;

  if (!host) {
    console.info(`[DevSeed] Creating managed host "${devHostName}"`);
    host = await hostRepo.create({
      name: devHostName,
      agentUrl: DEV_AGENT_URL,
      capabilities: { docker: true },
      sshHost: DEV_SSH_HOST,
    });
  } else {
    const fields: { agentUrl?: string; sshHost?: string } = {};
    if (host.agentUrl !== DEV_AGENT_URL) fields.agentUrl = DEV_AGENT_URL;
    if (host.sshHost === null) fields.sshHost = DEV_SSH_HOST;
    if (Object.keys(fields).length > 0) {
      await hostRepo.update(host.id, fields);
      console.info(`[DevSeed] Updated ${Object.keys(fields).join(', ')} for "${devHostName}"`);
    }
  }

  const existingPubKey = await keypairs.getPublicJwkForHost(devHostName);
  if (!existingPubKey) {
    console.info('[DevSeed] Generating dev agent keypair');
    const created = await keypairs.createForHost(devHostName);
    writePubkeyFile(DEFAULT_PUBKEY_FILE, created.publicJwk);
    console.info(`[DevSeed] Wrote public JWK to ${DEFAULT_PUBKEY_FILE}`);
  } else if (!existsSync(DEFAULT_PUBKEY_FILE)) {
    writePubkeyFile(DEFAULT_PUBKEY_FILE, existingPubKey);
    console.info(`[DevSeed] Re-wrote public JWK file to ${DEFAULT_PUBKEY_FILE}`);
  }

  await hostRepo.updateStatus(host.id, 'pending');
  for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt++) {
    let isHealthy = false;
    try {
      const response = await fetch(`${DEV_HEALTH_CHECK_URL}/health`);
      if (response.ok) isHealthy = true;
    } catch {
      // Agent not ready yet
    }
    if (isHealthy) {
      await hostRepo.updateStatus(host.id, 'healthy');
      return;
    }
    if (attempt < HEALTH_CHECK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_DELAY_MS));
    }
  }
  console.info('[DevSeed] Agent health check failed; host stays "pending"');
}

function writePubkeyFile(path: string, jwk: JWK): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(jwk), { mode: 0o644 });
}
