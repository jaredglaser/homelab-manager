-- Drop the stack_status table and its associated trigger/function.
-- Stack state is now derived from docker_container_events grouped by compose_project.
DROP TRIGGER IF EXISTS stack_status_notify ON stack_status;
DROP FUNCTION IF EXISTS notify_stack_change();
DROP TABLE IF EXISTS stack_status;
