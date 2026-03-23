CREATE TABLE stack_status (
  stack TEXT NOT NULL,
  host TEXT NOT NULL REFERENCES managed_hosts(name) ON DELETE CASCADE,
  containers JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stack, host)
);

CREATE OR REPLACE FUNCTION notify_stack_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('stack_change', row_to_json(OLD)::text);
    RETURN OLD;
  END IF;
  PERFORM pg_notify('stack_change', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stack_status_notify
  AFTER INSERT OR UPDATE OR DELETE ON stack_status
  FOR EACH ROW EXECUTE FUNCTION notify_stack_change();
