-- Ansible execution layer (proof of concept, gated behind ANSIBLE_RUNNER_ENABLED).
-- Runs are recorded by the web process that dispatched them; the sidecar keeps no
-- durable state of its own, so a restart mid-run leaves a row this schema can
-- recover the same way startup-recovery.ts handles stranded deploys.
CREATE TABLE IF NOT EXISTS ansible_runs (
  id BIGSERIAL PRIMARY KEY,
  -- Opaque identifier handed to the sidecar. Constrained to the character class the
  -- sidecar's route regex accepts, so a row can never name a run it cannot address.
  run_id TEXT NOT NULL UNIQUE CHECK (run_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  playbook TEXT NOT NULL,
  hosts TEXT[] NOT NULL,
  check_mode BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  summaries JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT valid_ansible_run_status
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_ansible_runs_created_at ON ansible_runs (created_at DESC);

-- Normalized runner events, not the raw job_events payload: the allowlist in
-- src/lib/ansible/events.ts is what decides which fields are ever persisted.
-- Sequence order, not `counter`, is the primary key: runner status frames carry no
-- counter of their own, so several events in one run legitimately share counter 0.
CREATE TABLE IF NOT EXISTS ansible_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES ansible_runs(id) ON DELETE CASCADE,
  counter INTEGER NOT NULL,
  payload JSONB NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ansible_run_events_run ON ansible_run_events (run_id, id);
