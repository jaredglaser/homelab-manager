import type { Pool } from 'pg';
import type { Role } from '@/lib/auth/types';
import { isRole } from '@/lib/auth/types';
import { parseRowEnum } from '@/lib/database/repositories/row-enum';

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

interface UserQueryRow {
  id: number | string;
  oidc_subject: string;
  email: string;
  name: string | null;
  role: string;
  oidc_groups: string[];
  last_login: Date;
  created_at: Date;
  updated_at: Date;
}

function rowToUser(row: UserQueryRow): UserRow {
  return {
    id: Number(row.id),
    oidcSubject: row.oidc_subject,
    email: row.email,
    name: row.name,
    role: parseRowEnum('users.role', row.role, isRole),
    oidcGroups: row.oidc_groups,
    lastLogin: row.last_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async upsertFromOidc(input: UpsertUserInput): Promise<UserRow> {
    const result = await this.pool.query<UserQueryRow>(
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
    return rowToUser(result.rows[0]);
  }

  async findById(id: number): Promise<UserRow | null> {
    const result = await this.pool.query<UserQueryRow>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
  }

  async findBySubject(oidcSubject: string): Promise<UserRow | null> {
    const result = await this.pool.query<UserQueryRow>('SELECT * FROM users WHERE oidc_subject = $1', [oidcSubject]);
    return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
  }

  async findAll(): Promise<UserRow[]> {
    const result = await this.pool.query<UserQueryRow>('SELECT * FROM users ORDER BY name ASC, email ASC');
    return result.rows.map(rowToUser);
  }
}
