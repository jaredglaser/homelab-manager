import type { Pool } from 'pg';
import type { AuthUser } from '@/lib/auth/types';

export interface CreateSessionInput {
  id: string;
  userId: number;
  encryptedOidc: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

export interface SessionRow {
  id: string;
  userId: number;
  encryptedOidc: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  createdAt: Date;
}

function rowToSession(row: {
  id: string;
  user_id: number;
  encrypted_oidc: string | null;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: Date;
  created_at: Date;
}): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    encryptedOidc: row.encrypted_oidc,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateSessionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, encrypted_oidc, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.userId, input.encryptedOidc, input.ipAddress, input.userAgent, input.expiresAt]
    );
  }

  async findById(hashedId: string): Promise<{ session: SessionRow; user: AuthUser } | null> {
    const result = await this.pool.query(
      `SELECT s.id, s.user_id, s.encrypted_oidc, s.ip_address, s.user_agent, s.expires_at, s.created_at,
              u.id as u_id, u.email, u.name, u.role
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [hashedId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as {
      id: string;
      user_id: number;
      encrypted_oidc: string | null;
      ip_address: string | null;
      user_agent: string | null;
      expires_at: Date;
      created_at: Date;
      u_id: number;
      email: string;
      name: string | null;
      role: AuthUser['role'];
    };
    return {
      session: rowToSession(row),
      user: { id: row.u_id, email: row.email, name: row.name, role: row.role },
    };
  }

  async findByUserId(userId: number): Promise<SessionRow[]> {
    const result = await this.pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return (result.rows as Parameters<typeof rowToSession>[0][]).map(rowToSession);
  }

  async deleteById(id: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  async deleteByUserId(userId: number): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async findAllWithUser(): Promise<(SessionRow & { userName: string | null; userEmail: string })[]> {
    const result = await this.pool.query(
      `SELECT s.id, s.user_id, s.encrypted_oidc, s.ip_address, s.user_agent, s.expires_at, s.created_at,
              u.name AS user_name, u.email AS user_email
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.expires_at > now()
       ORDER BY s.created_at DESC`
    );
    return (result.rows as (Parameters<typeof rowToSession>[0] & { user_name: string | null; user_email: string })[]).map(row => ({
      ...rowToSession(row),
      userName: row.user_name ?? null,
      userEmail: row.user_email,
    }));
  }

  async deleteExpired(): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  }
}
