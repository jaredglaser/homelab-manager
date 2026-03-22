import type { Pool } from 'pg';
import type { Role } from '@/lib/auth/types';

export interface UserRow {
  id: number;
  oidc_subject: string;
  email: string;
  name: string | null;
  role: Role;
  oidc_groups: string[];
  last_login: Date;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertUserInput {
  oidcSubject: string;
  email: string;
  name: string | null;
  role: Role;
  groups: string[];
}

function rowToUser(row: UserRow): UserRow {
  return {
    id: row.id,
    oidc_subject: row.oidc_subject,
    email: row.email,
    name: row.name,
    role: row.role,
    oidc_groups: row.oidc_groups,
    last_login: row.last_login,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async upsertFromOidc(input: UpsertUserInput): Promise<UserRow> {
    const result = await this.pool.query(
      `INSERT INTO users (oidc_subject, email, name, role, oidc_groups, last_login)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (oidc_subject) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         oidc_groups = EXCLUDED.oidc_groups,
         last_login = now(),
         updated_at = now()
       RETURNING *`,
      [input.oidcSubject, input.email, input.name, input.role, JSON.stringify(input.groups)]
    );
    return rowToUser(result.rows[0] as UserRow);
  }

  async findById(id: number): Promise<UserRow | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows.length > 0 ? rowToUser(result.rows[0] as UserRow) : null;
  }

  async findBySubject(oidcSubject: string): Promise<UserRow | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE oidc_subject = $1', [oidcSubject]);
    return result.rows.length > 0 ? rowToUser(result.rows[0] as UserRow) : null;
  }

  async findAll(): Promise<UserRow[]> {
    const result = await this.pool.query('SELECT * FROM users ORDER BY name ASC, email ASC');
    return (result.rows as UserRow[]).map(rowToUser);
  }
}
