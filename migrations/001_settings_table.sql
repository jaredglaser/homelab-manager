-- Application settings (key-value store)
-- Keys use path-style naming: 'docker/memoryDisplayMode'

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
