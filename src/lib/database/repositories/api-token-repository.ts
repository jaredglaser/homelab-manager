import '@tanstack/react-start/server-only';
import type { Pool } from 'pg';

export interface ApiTokenRow {
  id: number;
  label: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ApiTokenHashMatch {
  id: number;
  scopes: string[];
}

export interface CreateApiTokenInput {
  encryptedToken: string;
  tokenHash: string;
  label: string;
  scopes: string[];
  /** Omitted or null means the token never expires. */
  expiresAt?: Date | null;
}

function rowToApiToken(row: {
  id: unknown;
  label: unknown;
  scopes: unknown;
  expires_at: unknown;
  last_used_at: unknown;
  created_at: unknown;
}): ApiTokenRow {
  return {
    id: Number(row.id),
    label: row.label as string,
    scopes: row.scopes as string[],
    expiresAt: (row.expires_at as Date | null) ?? null,
    lastUsedAt: (row.last_used_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

export class ApiTokenRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateApiTokenInput): Promise<ApiTokenRow> {
    const result = await this.pool.query(
      `INSERT INTO api_tokens (encrypted_token, token_hash, label, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, scopes, expires_at, last_used_at, created_at`,
      [input.encryptedToken, input.tokenHash, input.label, input.scopes, input.expiresAt ?? null]
    );
    return rowToApiToken(result.rows[0] as Parameters<typeof rowToApiToken>[0]);
  }

  async findAll(): Promise<ApiTokenRow[]> {
    const result = await this.pool.query(
      `SELECT id, label, scopes, expires_at, last_used_at, created_at
       FROM api_tokens
       ORDER BY created_at DESC`
    );
    return (result.rows as Parameters<typeof rowToApiToken>[0][]).map(rowToApiToken);
  }

  /** Excludes rows past expires_at: an expired token authenticates nothing. */
  async findByTokenHash(tokenHash: string): Promise<ApiTokenHashMatch | null> {
    const result = await this.pool.query(
      `SELECT id, scopes FROM api_tokens WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [tokenHash]
    );
    const row = result.rows[0] as { id: unknown; scopes: unknown } | undefined;
    if (!row) return null;
    return { id: Number(row.id), scopes: row.scopes as string[] };
  }

  async deleteById(id: number): Promise<void> {
    await this.pool.query('DELETE FROM api_tokens WHERE id = $1', [id]);
  }

  async updateLastUsed(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE api_tokens SET last_used_at = now() WHERE id = $1',
      [id]
    );
  }
}
