-- migrations/039_findings.sql
-- Where the Hermes agent writes its conclusions back (plan section 6.1 "Report") and where
-- the operator reads them (section 6.8, findings feed). Written only through
-- FindingsRepository, which is the sole caller of the ON CONFLICT path below.
--
-- Not a hypertable and no retention policy: a finding is the durable record of a
-- conclusion, not a sample. Volume is bounded by the dedupe key, rather than by time: a container
-- that fails the same way every hour produces one row with occurrences=N, not N rows.

CREATE TABLE IF NOT EXISTS findings (
  id             BIGSERIAL PRIMARY KEY,
  subject_kind   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  entity_ids     TEXT[] NOT NULL DEFAULT '{}',
  fingerprint    TEXT NOT NULL,
  severity       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '',
  evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,
  incident_ids   TEXT[] NOT NULL DEFAULT '{}',
  run_id         TEXT,
  source         TEXT NOT NULL DEFAULT 'agent',
  occurrences    INTEGER NOT NULL DEFAULT 1,
  window_from    TIMESTAMPTZ,
  window_to      TIMESTAMPTZ,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT findings_subject_kind_check CHECK (subject_kind IN ('container', 'stack', 'host')),
  CONSTRAINT findings_severity_check     CHECK (severity IN ('info', 'warning', 'critical')),
  CONSTRAINT findings_status_check       CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT findings_source_check       CHECK (source IN ('agent', 'operator')),
  CONSTRAINT findings_occurrences_check  CHECK (occurrences >= 1),
  -- Bounds the NOTIFY payload below to a provable size; the trigger carries subject_id.
  CONSTRAINT findings_subject_id_len     CHECK (length(subject_id) <= 512),
  CONSTRAINT findings_fingerprint_len    CHECK (length(fingerprint) BETWEEN 3 AND 120),
  CONSTRAINT findings_closed_has_note    CHECK (status = 'open' OR resolved_at IS NOT NULL)
);

-- The dedupe contract. An agent re-investigating a recurring fault re-sends the same
-- (subject_kind, subject_id, fingerprint) and updates its open finding in place. The
-- predicate is what makes recurrence-after-resolution a NEW finding rather than a
-- reopening: closing a finding frees the slot, so a fault that comes back is news again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_open_dedupe
  ON findings (subject_kind, subject_id, fingerprint)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_findings_recent  ON findings (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_open    ON findings (last_seen_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_findings_subject ON findings (subject_id, last_seen_at DESC);

CREATE OR REPLACE FUNCTION notify_finding_change() RETURNS trigger AS $$
BEGIN
  -- Routing keys only. Every field here is length-bounded by a CHECK or an enum, so this
  -- payload is provably under 1 kB and can never approach pg_notify's 8 kB cap. Adding
  -- title/detail/evidence would put an unbounded value in a payload whose overflow aborts
  -- the INSERT that produced it. FindingsBroadcastService re-reads the row by id.
  PERFORM pg_notify('finding_change', json_build_object(
    'id', NEW.id,
    'op', TG_OP,
    'subject_kind', NEW.subject_kind,
    'subject_id', NEW.subject_id,
    'severity', NEW.severity,
    'status', NEW.status
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER findings_notify
  AFTER INSERT OR UPDATE ON findings
  FOR EACH ROW EXECUTE FUNCTION notify_finding_change();

-- Rollback:
-- DROP TRIGGER IF EXISTS findings_notify ON findings;
-- DROP FUNCTION IF EXISTS notify_finding_change();
-- DROP TABLE IF EXISTS findings;
