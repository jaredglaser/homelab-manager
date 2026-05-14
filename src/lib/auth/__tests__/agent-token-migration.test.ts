import { describe, it, expect } from 'bun:test';
import { migrateAgentTokensToTransit } from '@/lib/auth/agent-token-migration';
import type { Pool } from 'pg';

describe('migrateAgentTokensToTransit', () => {
  it('is a no-op — agent tokens are now Ed25519 keypairs', async () => {
    // managed_hosts no longer has an agent_token column; tokens are Ed25519 keypairs
    // stored in the agent_keypairs table (migration 022). This function exists only
    // for backward compat with callers that were written before the keypair migration.
    const result = await migrateAgentTokensToTransit({} as Pool, undefined);
    expect(result).toEqual({ migrated: 0, failed: 0 });
  });
});
