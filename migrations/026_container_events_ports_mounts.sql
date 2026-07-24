ALTER TABLE docker_container_events
  ADD COLUMN IF NOT EXISTS ports JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mounts JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION notify_docker_container_event() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  -- labels/mounts excluded from NOTIFY payload: PG NOTIFY has an 8 kB cap and both are
  -- unbounded; consumers re-fetch them from the init snapshot when needed.
  payload := json_build_object(
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
    'exit_code', NEW.exit_code,
    'ports', NEW.ports
  )::text;

  -- ports is bounded in practice but not by schema; guard against a pathological
  -- container blowing the 8 kB pg_notify cap (a failing pg_notify aborts the INSERT).
  -- NULL (not []) keeps the fallback distinguishable from a real empty port list.
  IF octet_length(payload) > 7500 THEN
    payload := json_build_object(
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
      'exit_code', NEW.exit_code,
      'ports', NULL
    )::text;
  END IF;

  PERFORM pg_notify('docker_container_change', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rollback:
-- CREATE OR REPLACE FUNCTION notify_docker_container_event() RETURNS trigger AS $$
-- BEGIN
--   PERFORM pg_notify('docker_container_change', json_build_object(
--     'at', NEW.at,
--     'host', NEW.host,
--     'container_id', NEW.container_id,
--     'event_type', NEW.event_type,
--     'state', NEW.state,
--     'name', NEW.name,
--     'image', NEW.image,
--     'compose_project', NEW.compose_project,
--     'service_key', NEW.service_key,
--     'started_at', NEW.started_at,
--     'finished_at', NEW.finished_at,
--     'exit_code', NEW.exit_code
--   )::text);
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
-- ALTER TABLE docker_container_events DROP COLUMN IF EXISTS ports, DROP COLUMN IF EXISTS mounts;
