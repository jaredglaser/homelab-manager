CREATE TABLE stack_status (
  stack TEXT NOT NULL,
  host TEXT NOT NULL REFERENCES managed_hosts(name) ON DELETE CASCADE,
  containers JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stack, host)
);

CREATE OR REPLACE FUNCTION notify_stack_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('stack_change', NEW.stack || '/' || NEW.host);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stack_status_notify
  AFTER INSERT OR UPDATE ON stack_status
  FOR EACH ROW EXECUTE FUNCTION notify_stack_change();
