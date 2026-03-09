CREATE TABLE IF NOT EXISTS container_versions (
  image TEXT PRIMARY KEY,
  current_tag TEXT,
  latest_tag TEXT,
  update_available BOOLEAN DEFAULT FALSE,
  github_repo TEXT,
  github_repo_source TEXT,
  releases JSONB DEFAULT '[]'::jsonb,
  checked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_container_versions_update_available
  ON container_versions (update_available) WHERE update_available = TRUE;
