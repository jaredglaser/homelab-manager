import type { Pool } from 'pg';
import type { TransitClient } from '@/lib/clients/transit-client';

export async function migrateAgentTokensToTransit(pool: Pool, transit: TransitClient): Promise<void> {
  const result = await pool.query(
    'SELECT id, agent_token FROM managed_hosts WHERE agent_token IS NOT NULL AND agent_token_encrypted IS NULL'
  );

  for (const row of result.rows) {
    try {
      const encrypted = await transit.encrypt('agent-tokens', row.agent_token as string);
      await pool.query(
        'UPDATE managed_hosts SET agent_token_encrypted = $1, agent_token = NULL WHERE id = $2',
        [encrypted, row.id]
      );
    } catch (error) {
      console.error(`[agent-token-migration] Failed to migrate token for host ${row.id}:`, error);
      // Continue with other rows — don't crash
    }
  }
}
