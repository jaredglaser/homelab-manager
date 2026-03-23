import type { Pool } from 'pg';
import type { Role } from '@/lib/auth/types';

export interface UserRow {
  id: number;
  oidcSubject: string;
  email: string;
  name: string | null;
  role: Role;
  oidcGroups: string[];
  lastLogin: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertUserInput {
  oidcSubject: string;
  email: string;
  name: string | null;
  role: Role;
  groups: string[];
}

function rowToUser(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as number,
    oidcSubject: row.oidc_subject as string,
    email: row.email as string,
    name: (row.name as string) ?? null,
    role: row.role as Role,
    oidcGroups: row.oidc_groups as string[],
    lastLogin: row.last_login as Date,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
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
    return rowToUser(result.rows[0] as Record<string, unknown>);
  }

  async findById(id: number): Promise<UserRow | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows.length > 0 ? rowToUser(result.rows[0] as Record<string, unknown>) : null;
  }

  async findBySubject(oidcSubject: string): Promise<UserRow | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE oidc_subject = $1', [oidcSubject]);
    return result.rows.length > 0 ? rowToUser(result.rows[0] as Record<string, unknown>) : null;
  }

  async findAll(): Promise<UserRow[]> {
    const result = await this.pool.query('SELECT * FROM users ORDER BY name ASC, email ASC');
    return (result.rows as Record<string, unknown>[]).map(rowToUser);
  }
}
