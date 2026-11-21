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
}

export interface CreateGitTokenInput {
  userId: number;
  encryptedToken: string;
  tokenHash: string;
  label: string;
}

interface GitTokenQueryRow {
  id: number;
  user_id: number;
  label: string;
  last_used_at: Date | null;
  created_at: Date;
}

interface GitTokenWithUserQueryRow extends GitTokenQueryRow {
  user_name: string | null;
  user_email: string;
}

interface GitTokenHashQueryRow {
  id: number;
  user_id: number;
}

/** Rows predating migration 027, where token_hash is still NULL. */
interface GitTokenEncryptedQueryRow {
  id: number;
  user_id: number;
  encrypted_token: string;
}

function rowToGitToken(row: GitTokenQueryRow): GitTokenRow {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
  };
}

export class GitTokenRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateGitTokenInput): Promise<GitTokenRow> {
    const result = await this.pool.query<GitTokenQueryRow>(
      `INSERT INTO git_tokens (user_id, encrypted_token, token_hash, label)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, label, last_used_at, created_at`,
      [input.userId, input.encryptedToken, input.tokenHash, input.label]
    );
    return rowToGitToken(result.rows[0]);
  }

  async findByUserId(userId: number): Promise<GitTokenRow[]> {
    const result = await this.pool.query<GitTokenQueryRow>(
      `SELECT id, user_id, label, last_used_at, created_at
       FROM git_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(rowToGitToken);
  }

  async findAll(): Promise<GitTokenWithUser[]> {
    const result = await this.pool.query<GitTokenWithUserQueryRow>(
      `SELECT gt.id, gt.user_id, gt.label, gt.last_used_at, gt.created_at,
              u.name AS user_name, u.email AS user_email
       FROM git_tokens gt
       JOIN users u ON gt.user_id = u.id
       ORDER BY gt.created_at DESC`
    );
    return result.rows.map(row => ({
      ...rowToGitToken(row),
      userName: row.user_name ?? null,
      userEmail: row.user_email,
    }));
  }

  async findByTokenHash(tokenHash: string): Promise<GitTokenHashMatch | null> {
    const result = await this.pool.query<GitTokenHashQueryRow>(
      `SELECT id, user_id FROM git_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { id: row.id, userId: row.user_id };
  }

  /** Rows predating migration 027, for the startup hash backfill. */
  async findMissingHash(): Promise<GitTokenWithEncrypted[]> {
    const result = await this.pool.query<GitTokenEncryptedQueryRow>(
      `SELECT id, user_id, encrypted_token FROM git_tokens WHERE token_hash IS NULL`
    );
    return result.rows.map(row => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      encryptedToken: row.encrypted_token,
    }));
  }

  async setTokenHash(id: number, tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE git_tokens SET token_hash = $2 WHERE id = $1',
      [id, tokenHash]
    );
  }

  async deleteById(id: number): Promise<void> {
    await this.pool.query('DELETE FROM git_tokens WHERE id = $1', [id]);
  }

  /** Deletes a token only if it is owned by the given user. Resolves to whether a row was removed. */
  async deleteByIdAndUser(id: number, userId: number): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM git_tokens WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return (result.rowCount ?? 0) > 0;
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
