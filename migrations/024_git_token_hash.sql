-- migrations/024_git_token_hash.sql
-- Indexed SHA-256 hash (hex) of the raw git token so auth is a single
-- indexed lookup instead of decrypting every row on each git HTTP request.
-- Pre-existing rows stay NULL and are backfilled on their next successful
-- legacy-scan auth.

ALTER TABLE git_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_tokens_token_hash ON git_tokens(token_hash);
