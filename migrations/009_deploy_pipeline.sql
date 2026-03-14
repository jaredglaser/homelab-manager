-- Managed Docker hosts with agent connections
CREATE TABLE IF NOT EXISTS managed_hosts (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  agent_url TEXT NOT NULL,
  agent_token_hash TEXT NOT NULL,
  socket_proxy_url TEXT NOT NULL,
  agent_version TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deploy history for stack deployments
CREATE TABLE IF NOT EXISTS deploy_history (
  id SERIAL PRIMARY KEY,
  stack TEXT NOT NULL,
  host TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  compose_hash TEXT NOT NULL,
  env_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger TEXT NOT NULL,
  logs TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying deploys by stack (concurrency checks, history)
CREATE INDEX IF NOT EXISTS idx_deploy_history_stack_status
  ON deploy_history (stack, status, created_at DESC);

-- Index for querying deploys by host
CREATE INDEX IF NOT EXISTS idx_deploy_history_host
  ON deploy_history (host, created_at DESC);

-- Index for finding the latest deploy per stack (change detection)
CREATE INDEX IF NOT EXISTS idx_deploy_history_latest
  ON deploy_history (stack, host, created_at DESC)
  WHERE status = 'succeeded';
