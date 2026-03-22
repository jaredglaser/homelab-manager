-- migrations/017_auth_tables.sql
-- OIDC authentication: users, sessions, and git tokens

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  oidc_subject  TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  oidc_groups   JSONB NOT NULL DEFAULT '[]',
  last_login    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_oidc  TEXT,
  ip_address      INET,
  user_agent      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS git_tokens (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_token     TEXT NOT NULL,
  label               TEXT NOT NULL,
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_git_tokens_user_id ON git_tokens(user_id);
