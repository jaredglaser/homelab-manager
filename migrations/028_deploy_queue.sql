-- Queue for git pushes blocked by an active deploy. The partial unique index
-- from 011 allows only one pending/in_progress row per stack+host, so a push
-- landing mid-deploy used to be reported failed and never retried, meaning the
-- newest commit silently never deployed.
-- One row per stack+host (PK): only the newest blocked push is kept. The full
-- DeployRequest is stored as JSONB so the pipeline can redispatch it verbatim
-- once the active deploy reaches a terminal state.
CREATE TABLE IF NOT EXISTS deploy_queue (
  stack TEXT NOT NULL,
  host TEXT NOT NULL,
  request JSONB NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stack, host),
  CONSTRAINT fk_deploy_queue_host
    FOREIGN KEY (host) REFERENCES managed_hosts(name) ON DELETE CASCADE
);

-- A queued push also gets a deploy_history marker row so it shows up in the
-- history list and on the stack-status channel. 'queued' is deliberately absent
-- from the active-deploy partial unique index in 011, so the marker can coexist
-- with the in-flight deploy it is waiting on.
ALTER TABLE deploy_history DROP CONSTRAINT IF EXISTS valid_status;

ALTER TABLE deploy_history ADD CONSTRAINT valid_status
  CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'no_change', 'queued'));
