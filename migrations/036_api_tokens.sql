-- migrations/036_api_tokens.sql
-- Machine tokens for the MCP server. Mirrors git_tokens (encrypted_token for raw-token
-- recovery, token_hash for the indexed auth lookup) plus a scopes array carrying the
-- grants, since a machine token authorizes a fixed set of operations rather than a user.

CREATE TABLE IF NOT EXISTS api_tokens (
  id                  SERIAL PRIMARY KEY,
  label               TEXT NOT NULL,
  encrypted_token     TEXT NOT NULL,
  token_hash          TEXT NOT NULL,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
