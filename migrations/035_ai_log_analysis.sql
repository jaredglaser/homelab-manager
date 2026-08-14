-- AI fleet log analysis (POC).
--
-- One OpenAI-compatible provider row, one profile per (host, container_key)
-- holding the bespoke analysis skill, one session per container per day, and
-- the observation/alert trail the orchestrator raises to the operator.
--
-- container_key is the compose service key (falling back to the container
-- name), never the container id: ids change on every redeploy and would
-- discard the learned skill each time a stack is updated.

CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  profiler_model TEXT,
  api_key_jwe TEXT,
  max_context_tokens INTEGER NOT NULL DEFAULT 32768,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_providers_max_context_positive CHECK (max_context_tokens > 0)
);

CREATE TABLE ai_container_profiles (
  host TEXT NOT NULL REFERENCES managed_hosts(name) ON DELETE CASCADE,
  container_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending',
  skill_markdown TEXT,
  skill_version INTEGER NOT NULL DEFAULT 0,
  sample_started_at TIMESTAMPTZ,
  sample_ended_at TIMESTAMPTZ,
  sample_line_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (host, container_key),
  CONSTRAINT ai_container_profiles_status_valid
    CHECK (status IN ('pending', 'profiling', 'ready', 'failed'))
);

CREATE TABLE ai_analysis_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host TEXT NOT NULL REFERENCES managed_hosts(name) ON DELETE CASCADE,
  container_key TEXT NOT NULL,
  day DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  batches_processed INTEGER NOT NULL DEFAULT 0,
  lines_processed BIGINT NOT NULL DEFAULT 0,
  -- Rolling compaction state. Persisted so a worker restart resumes the day
  -- with the narrative so far instead of re-reading logs already dropped by
  -- Docker's own rotation.
  running_summary TEXT,
  report_markdown TEXT,
  model TEXT,
  error TEXT,
  UNIQUE (host, container_key, day),
  CONSTRAINT ai_analysis_sessions_status_valid
    CHECK (status IN ('active', 'closed', 'failed'))
);

CREATE INDEX ai_analysis_sessions_recent
  ON ai_analysis_sessions (host, container_key, day DESC);

CREATE TABLE ai_observations (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES ai_analysis_sessions(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  container_key TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  triaged BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ai_observations_severity_valid
    CHECK (severity IN ('info', 'notice', 'warning', 'critical'))
);

CREATE INDEX ai_observations_recent ON ai_observations (at DESC);
CREATE INDEX ai_observations_untriaged ON ai_observations (at) WHERE NOT triaged;

CREATE TABLE ai_alerts (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  investigation TEXT,
  entities TEXT[] NOT NULL DEFAULT '{}',
  observation_ids BIGINT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  CONSTRAINT ai_alerts_severity_valid
    CHECK (severity IN ('info', 'notice', 'warning', 'critical')),
  CONSTRAINT ai_alerts_status_valid
    CHECK (status IN ('open', 'acknowledged', 'dismissed'))
);

CREATE INDEX ai_alerts_open ON ai_alerts (at DESC) WHERE status = 'open';

-- Payload carries routing keys only; the web layer re-reads the rows it needs.
-- Titles, details and skill markdown are unbounded and NOTIFY caps at 8 kB.
-- Split in two because PL/pgSQL resolves NEW.<field> even inside a CASE arm,
-- so one shared function would fail on ai_alerts, which has no host column.
CREATE OR REPLACE FUNCTION notify_ai_entity_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ai_analysis_change', json_build_object(
    'kind', TG_ARGV[0],
    'host', NEW.host,
    'containerKey', NEW.container_key
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notify_ai_alert_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ai_analysis_change', json_build_object('kind', 'alert')::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_container_profiles_notify
  AFTER INSERT OR UPDATE ON ai_container_profiles
  FOR EACH ROW EXECUTE FUNCTION notify_ai_entity_change('profile');

CREATE TRIGGER ai_analysis_sessions_notify
  AFTER INSERT OR UPDATE ON ai_analysis_sessions
  FOR EACH ROW EXECUTE FUNCTION notify_ai_entity_change('session');

CREATE TRIGGER ai_observations_notify
  AFTER INSERT ON ai_observations
  FOR EACH ROW EXECUTE FUNCTION notify_ai_entity_change('observation');

CREATE TRIGGER ai_alerts_notify
  AFTER INSERT OR UPDATE ON ai_alerts
  FOR EACH ROW EXECUTE FUNCTION notify_ai_alert_change();
