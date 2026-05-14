import type { Pool } from 'pg';

/**
 * Agent tokens are now stored as Ed25519 keypairs in the `agent_keypairs` table
 * (see migration 022_agent_keypairs.sql). There are no plaintext agent tokens to
 * migrate.
 *
 * This function is kept as a no-op so any callers written before the keypair
 * migration continue to compile without changes.
 */
export async function migrateAgentTokensToTransit(
  _pool: Pool,
  _transit: unknown,
): Promise<{ migrated: number; failed: number }> {
  return { migrated: 0, failed: 0 };
}
