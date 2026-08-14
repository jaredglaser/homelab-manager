import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { encryptValue, decryptValue } from '@/lib/crypto/encrypted-value';
import type { AiProviderConfig } from '@/types/ai';

/** Single-row table; the POC targets one endpoint at a time. */
export const AI_PROVIDER_ID = 'default';

export interface AiProviderRow extends AiProviderConfig {
  /** Decrypted key, present only on the worker-side read path. */
  apiKey: string | null;
}

export interface SaveAiProviderInput {
  baseUrl: string;
  model: string;
  profilerModel: string | null;
  maxContextTokens: number;
  /** `undefined` keeps the stored key, `null` clears it, a string replaces it. */
  apiKey?: string | null;
}

interface RawRow {
  base_url: string;
  model: string;
  profiler_model: string | null;
  api_key_jwe: string | null;
  max_context_tokens: number;
}

export class AiProviderRepository {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: MasterKeyring,
  ) {}

  private async load(): Promise<RawRow | null> {
    const result = await this.pool.query(
      `SELECT base_url, model, profiler_model, api_key_jwe, max_context_tokens
       FROM ai_providers WHERE id = $1`,
      [AI_PROVIDER_ID],
    );
    return (result.rows[0] as RawRow | undefined) ?? null;
  }

  /** Config without the secret, safe to hand to the browser. */
  async getConfig(): Promise<AiProviderConfig | null> {
    const row = await this.load();
    if (!row) return null;
    return {
      baseUrl: row.base_url,
      model: row.model,
      profilerModel: row.profiler_model,
      hasApiKey: row.api_key_jwe !== null,
      maxContextTokens: Number(row.max_context_tokens),
    };
  }

  /**
   * Config including the decrypted key, for the worker's model factory.
   * A key that no loaded master key can decrypt yields `apiKey: null` rather
   * than throwing: many local endpoints ignore the header entirely, so a
   * stale ciphertext should not take the whole analysis pipeline offline.
   */
  async getWithKey(): Promise<AiProviderRow | null> {
    const row = await this.load();
    if (!row) return null;
    let apiKey: string | null = null;
    if (row.api_key_jwe !== null) {
      try {
        apiKey = await decryptValue(row.api_key_jwe, this.keyring);
      } catch (err) {
        console.error(
          '[AiProviderRepository] API key decryption failed, continuing without it:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    return {
      baseUrl: row.base_url,
      model: row.model,
      profilerModel: row.profiler_model,
      hasApiKey: row.api_key_jwe !== null,
      maxContextTokens: Number(row.max_context_tokens),
      apiKey,
    };
  }

  async save(input: SaveAiProviderInput): Promise<void> {
    const keyJwe =
      input.apiKey === undefined || input.apiKey === null
        ? null
        : await encryptValue(input.apiKey, this.keyring);

    // COALESCE on the update arm keeps the stored key when apiKey is undefined;
    // an explicit null clears it, which is why the two cases pass different
    // values for $6.
    const keepExisting = input.apiKey === undefined;
    await this.pool.query(
      `INSERT INTO ai_providers (id, base_url, model, profiler_model, max_context_tokens, api_key_jwe, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         base_url = EXCLUDED.base_url,
         model = EXCLUDED.model,
         profiler_model = EXCLUDED.profiler_model,
         max_context_tokens = EXCLUDED.max_context_tokens,
         api_key_jwe = CASE WHEN $7 THEN ai_providers.api_key_jwe ELSE EXCLUDED.api_key_jwe END,
         updated_at = now()`,
      [
        AI_PROVIDER_ID,
        input.baseUrl,
        input.model,
        input.profilerModel,
        input.maxContextTokens,
        keyJwe,
        keepExisting,
      ],
    );
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM ai_providers WHERE id = $1', [AI_PROVIDER_ID]);
  }
}
