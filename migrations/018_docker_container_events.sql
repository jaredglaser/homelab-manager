CREATE TABLE docker_container_events (
  at TIMESTAMPTZ NOT NULL,
  host TEXT NOT NULL REFERENCES managed_hosts(name) ON DELETE CASCADE,
  container_id TEXT NOT NULL,
  event_type TEXT NOT NULL,        -- 'upsert' | 'destroy'
  state TEXT,                      -- present for 'upsert', null for 'destroy'
  name TEXT,
  image TEXT,
  labels JSONB NOT NULL DEFAULT '{}',
  compose_project TEXT GENERATED ALWAYS AS (labels->>'com.docker.compose.project') STORED,
  service_key TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  exit_code INTEGER
);

SELECT create_hypertable('docker_container_events', 'at');

CREATE INDEX docker_container_events_latest
  ON docker_container_events (host, container_id, at DESC);

CREATE INDEX docker_container_events_compose_project
  ON docker_container_events (host, compose_project, at DESC)
  WHERE compose_project IS NOT NULL;

CREATE OR REPLACE FUNCTION notify_docker_container_event() RETURNS trigger AS $$
BEGIN
  -- labels excluded from NOTIFY payload: PG NOTIFY has an 8 kB cap and label maps are unbounded;
  -- consumers re-fetch labels from the init snapshot when needed.
  PERFORM pg_notify('docker_container_change', json_build_object(
    'at', NEW.at,
    'host', NEW.host,
    'container_id', NEW.container_id,
    'event_type', NEW.event_type,
    'state', NEW.state,
    'name', NEW.name,
    'image', NEW.image,
    'compose_project', NEW.compose_project,
    'service_key', NEW.service_key,
    'started_at', NEW.started_at,
    'finished_at', NEW.finished_at,
    'exit_code', NEW.exit_code
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER docker_container_events_notify
  AFTER INSERT ON docker_container_events
  FOR EACH ROW EXECUTE FUNCTION notify_docker_container_event();

-- Rollback:
-- DROP TRIGGER IF EXISTS docker_container_events_notify ON docker_container_events;
-- DROP FUNCTION IF EXISTS notify_docker_container_event();
-- DROP TABLE IF EXISTS docker_container_events;
