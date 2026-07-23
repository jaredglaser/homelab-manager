import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { encryptValue, decryptValue } from '@/lib/crypto/encrypted-value';

/** Thrown when a stored secret can't be decrypted (wrong or rotated MASTER_KEY). The deploy secret resolver matches on this to classify decryption failures apart from other errors (DB, etc.), since the operator fix differs. */
export const SECRET_DECRYPTION_FAILED_MESSAGE = 'Secret decryption failed';

export class StackSecretsRepository {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: MasterKeyring,
  ) {}

  async list(stackName: string): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT variable_name FROM stack_secrets WHERE stack_name = $1 ORDER BY variable_name ASC',
      [stackName],
    );
    return result.rows.map((r) => (r as { variable_name: string }).variable_name);
  }

  async get(stackName: string, variableName: string): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT ciphertext_jwe FROM stack_secrets WHERE stack_name = $1 AND variable_name = $2',
      [stackName, variableName],
    );
    if (result.rows.length === 0) return null;
    try {
      return await decryptValue((result.rows[0] as { ciphertext_jwe: string }).ciphertext_jwe, this.keyring);
    } catch {
      throw new Error(SECRET_DECRYPTION_FAILED_MESSAGE);
    }
  }

  /**
   * Fetch every variable name and its decrypted value for a stack in one query,
   * so the secrets UI can load all values without a per-variable round trip.
   */
  async getAll(stackName: string): Promise<Record<string, string>> {
    const result = await this.pool.query(
      'SELECT variable_name, ciphertext_jwe FROM stack_secrets WHERE stack_name = $1 ORDER BY variable_name ASC',
      [stackName],
    );
    const entries = await Promise.all(
      result.rows.map(async (r) => {
        const row = r as { variable_name: string; ciphertext_jwe: string };
        try {
          return [row.variable_name, await decryptValue(row.ciphertext_jwe, this.keyring)] as const;
        } catch {
          throw new Error(SECRET_DECRYPTION_FAILED_MESSAGE);
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async set(stackName: string, variableName: string, value: string): Promise<void> {
    const jwe = await encryptValue(value, this.keyring);
    await this.pool.query(
      `INSERT INTO stack_secrets (stack_name, variable_name, ciphertext_jwe, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (stack_name, variable_name)
       DO UPDATE SET ciphertext_jwe = EXCLUDED.ciphertext_jwe, updated_at = now()`,
      [stackName, variableName, jwe],
    );
  }

  async delete(stackName: string, variableName: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM stack_secrets WHERE stack_name = $1 AND variable_name = $2',
      [stackName, variableName],
    );
  }

  async ensureExists(stackName: string, variableName: string): Promise<void> {
    const jwe = await encryptValue('', this.keyring);
    await this.pool.query(
      `INSERT INTO stack_secrets (stack_name, variable_name, ciphertext_jwe)
       VALUES ($1, $2, $3)
       ON CONFLICT (stack_name, variable_name) DO NOTHING`,
      [stackName, variableName, jwe],
    );
  }
}
