-- Current ZFS pool health per host, as the host's agent last reported it.
-- pools holds the last health the agent could read, so it stays while readable is false or connected is false.
-- last_seen_at is when the worker last held the agent's stream: set on each report and when the stream drops.
CREATE TABLE IF NOT EXISTS zfs_host_health (
  host         TEXT PRIMARY KEY REFERENCES managed_hosts (name) ON DELETE CASCADE ON UPDATE CASCADE,
  readable     BOOLEAN NOT NULL,
  connected    BOOLEAN NOT NULL,
  pools        JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT zfs_host_health_pools_array CHECK (jsonb_typeof(pools) = 'array')
);

CREATE OR REPLACE FUNCTION notify_zfs_host_health_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('zfs_health_change', OLD.host);
  ELSE
    PERFORM pg_notify('zfs_health_change', NEW.host);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zfs_host_health_notify ON zfs_host_health;
CREATE TRIGGER zfs_host_health_notify
  AFTER INSERT OR UPDATE OR DELETE ON zfs_host_health
  FOR EACH ROW EXECUTE FUNCTION notify_zfs_host_health_change();
