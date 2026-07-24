import '@tanstack/react-start/server-only';
import type { Pool } from 'pg';

export interface GitTokenRow {
  id: number;
  userId: number;
  label: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface GitTokenWithUser extends GitTokenRow {
  userName: string | null;
  userEmail: string;
}

export interface GitTokenWithEncrypted {
  id: number;
  userId: number;
  encryptedToken: string;
}

export interface GitTokenHashMatch {
  id: number;
  userId: number;
  tokenHash: string;
}

export interface CreateGitTokenInput {
  userId: number;
  encryptedToken: string;
  tokenHash: string;
  label: string;
}

function rowToGitToken(row: {
  id: unknown;
  user_id: unknown;
  label: unknown;
  last_used_at: unknown;
  created_at: unknown;
}): GitTokenRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    label: row.label as string,
    lastUsedAt: (row.last_used_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

export class GitTokenRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateGitTokenInput): Promise<GitTokenRow> {
    const result = await this.pool.query(
      `INSERT INTO git_tokens (user_id, encrypted_token, token_hash, label)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, label, last_used_at, created_at`,
      [input.userId, input.encryptedToken, input.tokenHash, input.label]
    );
    return rowToGitToken(result.rows[0] as Parameters<typeof rowToGitToken>[0]);
  }

  async findByUserId(userId: number): Promise<GitTokenRow[]> {
    const result = await this.pool.query(
      `SELECT id, user_id, label, last_used_at, created_at
       FROM git_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return (result.rows as Parameters<typeof rowToGitToken>[0][]).map(rowToGitToken);
  }

  async findAll(): Promise<GitTokenWithUser[]> {
    const result = await this.pool.query(
      `SELECT gt.id, gt.user_id, gt.label, gt.last_used_at, gt.created_at,
              u.name AS user_name, u.email AS user_email
       FROM git_tokens gt
       JOIN users u ON gt.user_id = u.id
       ORDER BY gt.created_at DESC`
    );
    return (result.rows as {
      id: unknown;
      user_id: unknown;
      label: unknown;
      last_used_at: unknown;
      created_at: unknown;
      user_name: unknown;
      user_email: unknown;
    }[]).map(row => ({
      ...rowToGitToken(row),
      userName: (row.user_name as string | null) ?? null,
      userEmail: row.user_email as string,
    }));
  }

  /** Indexed lookup for the auth fast path. Returns null when no row matches. */
  async findByTokenHash(tokenHash: string): Promise<GitTokenHashMatch | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, token_hash FROM git_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    const row = result.rows[0] as
      | { id: unknown; user_id: unknown; token_hash: unknown }
      | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      tokenHash: row.token_hash as string,
    };
  }

  /**
   * Tokens created before the token_hash column existed (migration 027).
   * Only these need the decrypt-and-compare fallback during auth.
   */
  async findLegacyEncrypted(): Promise<GitTokenWithEncrypted[]> {
    const result = await this.pool.query(
      `SELECT id, user_id, encrypted_token FROM git_tokens WHERE token_hash IS NULL`
    );
    return (result.rows as { id: unknown; user_id: unknown; encrypted_token: unknown }[]).map(row => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      encryptedToken: row.encrypted_token as string,
    }));
  }

  /** Backfill the hash for a legacy token after a successful auth match. */
  async setTokenHash(id: number, tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE git_tokens SET token_hash = $2 WHERE id = $1',
      [id, tokenHash]
    );
  }

  async deleteById(id: number): Promise<void> {
    await this.pool.query('DELETE FROM git_tokens WHERE id = $1', [id]);
  }

  async deleteByUserId(userId: number): Promise<void> {
    await this.pool.query('DELETE FROM git_tokens WHERE user_id = $1', [userId]);
  }

  async updateLastUsed(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE git_tokens SET last_used_at = now() WHERE id = $1',
      [id]
    );
  }
}
