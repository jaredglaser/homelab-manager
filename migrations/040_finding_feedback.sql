-- migrations/040_finding_feedback.sql
-- Phase 3 of the Hermes log-analysis plan (docs/hermes-log-analysis-plan.md, section 5.1):
-- ground truth for whether a finding was right. Four sources of label, one append-only
-- ledger (finding_labels), plus the supporting tables the demotion/miss audit needs
-- (reported_misses, incidents, log_shape_lane_history, detector_rule_transitions).
--
-- finding_labels is append-only, not one row per finding: a relabel is a new row pointing
-- at the row it supersedes via supersedes_label_id. This is what makes "the labels as of
-- <date>" reproducible for a GEPA training split, and it keeps a Monday-noise/Thursday-
-- actionable relabel (the most informative row in the table) instead of overwriting it.
-- There is no UPDATE finding_labels anywhere in this codebase; there must never be one.

CREATE TABLE IF NOT EXISTS finding_labels (
  id                       BIGSERIAL PRIMARY KEY,
  finding_id               BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  verdict                  TEXT NOT NULL,
  source                   TEXT NOT NULL,
  weight                   REAL NOT NULL,
  signal                   TEXT,
  basis_at                 TIMESTAMPTZ,
  confounders              TEXT[] NOT NULL DEFAULT '{}',
  evidence                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  duplicate_of_finding_id  BIGINT REFERENCES findings(id) ON DELETE SET NULL,
  note                     TEXT NOT NULL DEFAULT '',
  labeled_by               TEXT,
  labeled_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  supersedes_label_id      BIGINT REFERENCES finding_labels(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT finding_labels_verdict_check
    CHECK (verdict IN ('actionable', 'noise', 'duplicate', 'wrong', 'inconclusive')),
  CONSTRAINT finding_labels_source_check
    CHECK (source IN ('operator', 'implicit', 'agent')),
  CONSTRAINT finding_labels_weight_range
    CHECK (weight > 0 AND weight <= 1),
  -- No non-operator row can ever weigh like a click. Advisory to the optimiser, structural here.
  CONSTRAINT finding_labels_non_operator_weight
    CHECK (source = 'operator' OR weight <= 0.5),
  CONSTRAINT finding_labels_operator_weight
    CHECK (source <> 'operator' OR weight = 1),
  -- 'inconclusive' records that the sweeper evaluated a window and found nothing decisive.
  -- A human is never inconclusive; they either click or they do not.
  CONSTRAINT finding_labels_inconclusive_is_implicit
    CHECK (verdict <> 'inconclusive' OR source = 'implicit'),
  CONSTRAINT finding_labels_operator_attributed
    CHECK (source <> 'operator' OR (labeled_by IS NOT NULL AND length(labeled_by) > 0)),
  CONSTRAINT finding_labels_implicit_has_signal
    CHECK (source <> 'implicit' OR (signal IS NOT NULL AND basis_at IS NOT NULL)),
  CONSTRAINT finding_labels_note_len CHECK (length(note) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_finding_labels_finding
  ON finding_labels (finding_id, labeled_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_finding_labels_explicit
  ON finding_labels (finding_id, labeled_at DESC, id DESC)
  WHERE source IN ('operator', 'agent');

CREATE INDEX IF NOT EXISTS idx_finding_labels_period
  ON finding_labels (labeled_at DESC)
  WHERE source = 'operator';

-- Makes the implicit sweep idempotent per (finding, signal, observation basis). basis_at is the
-- finding.last_seen_at the inference ran against: when a closed-over fault recurs and last_seen_at
-- moves, the same signal is legitimately re-evaluated and gets a new row rather than being skipped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_labels_implicit_once
  ON finding_labels (finding_id, signal, basis_at)
  WHERE source = 'implicit';

-- One row per finding: the current deliberate verdict. Implicit rows are structurally absent,
-- which is how "implicit never overrides explicit" is guaranteed rather than promised.
CREATE OR REPLACE VIEW finding_label_current AS
SELECT DISTINCT ON (l.finding_id)
  l.finding_id, l.id AS label_id, l.verdict, l.source, l.note,
  l.duplicate_of_finding_id, l.labeled_by, l.labeled_at, l.supersedes_label_id
FROM finding_labels l
WHERE l.source IN ('operator', 'agent')
ORDER BY l.finding_id,
         (l.source = 'operator') DESC,   -- a human statement outranks the agent's own correction
         l.labeled_at DESC, l.id DESC;

-- The weak layer, kept separate on purpose. Never joined into a verdict.
-- The confounder list is aggregated in a separate LATERAL subquery, not unnested inline: an
-- inline unnest multiplies every finding_labels row by cardinality(confounders) before the
-- GROUP BY, inflating SUM(weight) and COUNT(*) by however many confounders each row carries.
CREATE OR REPLACE VIEW finding_weak_signals AS
SELECT
  agg.finding_id,
  agg.actionable_weight,
  agg.noise_weight,
  agg.signal_count,
  agg.signals,
  COALESCE(conf.confounders, '{}') AS confounders,
  agg.last_inferred_at
FROM (
  SELECT
    finding_id,
    LEAST(0.5, SUM(weight) FILTER (WHERE verdict = 'actionable'))::real AS actionable_weight,
    LEAST(0.5, SUM(weight) FILTER (WHERE verdict = 'noise'))::real      AS noise_weight,
    COUNT(*) FILTER (WHERE verdict <> 'inconclusive')                   AS signal_count,
    array_remove(array_agg(DISTINCT signal), NULL)                      AS signals,
    MAX(labeled_at)                                                     AS last_inferred_at
  FROM finding_labels
  WHERE source = 'implicit'
  GROUP BY finding_id
) agg
LEFT JOIN LATERAL (
  SELECT array_remove(array_agg(DISTINCT c), NULL) AS confounders
  FROM finding_labels l
  LEFT JOIN LATERAL unnest(l.confounders) AS c ON TRUE
  WHERE l.source = 'implicit' AND l.finding_id = agg.finding_id
) conf ON TRUE;

-- The training set. Explicit human labels only. This is what GEPA and the phase-4 promotion
-- gate read; nothing else. Named so that an accidental join against the wrong view is obvious
-- in review.
CREATE OR REPLACE VIEW finding_training_labels AS
SELECT c.finding_id, c.verdict, c.labeled_at, c.labeled_by, c.note,
       f.fingerprint, f.subject_kind, f.subject_id, f.entity_ids, f.severity,
       f.run_id, f.incident_ids, f.first_seen_at
FROM finding_label_current c
JOIN findings f ON f.id = c.finding_id
WHERE c.source = 'operator' AND c.verdict <> 'inconclusive';

-- Reported misses: "this broke at 21:40 and you said nothing." The only signal that
-- measures recall rather than precision, and therefore the rarest and most valuable.
CREATE TABLE IF NOT EXISTS reported_misses (
  id                 BIGSERIAL PRIMARY KEY,
  window_from        TIMESTAMPTZ NOT NULL,
  window_to          TIMESTAMPTZ NOT NULL,
  entity_ids         TEXT[] NOT NULL,
  host               TEXT,
  stack_project      TEXT,
  what_happened      TEXT NOT NULL,
  severity           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'new',
  attribution        JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_verdict TEXT,
  attributed_at      TIMESTAMPTZ,
  matched_finding_ids BIGINT[] NOT NULL DEFAULT '{}',
  matched_incident_ids TEXT[] NOT NULL DEFAULT '{}',
  reported_by        TEXT NOT NULL,
  reported_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note               TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT reported_misses_window_ordered CHECK (window_from < window_to),
  CONSTRAINT reported_misses_window_bounded
    CHECK (window_to - window_from <= INTERVAL '7 days'),
  CONSTRAINT reported_misses_entities_present CHECK (cardinality(entity_ids) BETWEEN 1 AND 50),
  CONSTRAINT reported_misses_severity_check CHECK (severity IN ('info', 'warning', 'critical')),
  CONSTRAINT reported_misses_status_check
    CHECK (status IN ('new', 'attributed', 'accepted', 'explained', 'invalid')),
  CONSTRAINT reported_misses_what_len CHECK (length(what_happened) BETWEEN 1 AND 4000),
  CONSTRAINT reported_misses_verdict_check
    CHECK (attribution_verdict IS NULL OR attribution_verdict IN
      ('nothing_recorded', 'counted_only', 'batched_only', 'dispatched_no_finding',
       'dispatch_dropped', 'finding_exists'))
);

CREATE INDEX IF NOT EXISTS idx_reported_misses_window ON reported_misses (window_from DESC);
CREATE INDEX IF NOT EXISTS idx_reported_misses_entities ON reported_misses USING GIN (entity_ids);
CREATE INDEX IF NOT EXISTS idx_reported_misses_open ON reported_misses (reported_at DESC)
  WHERE status IN ('new', 'attributed');

-- Persisted incidents. The coalescer is in-memory; without this the demotion audit cannot say
-- "these signals fired and here is the lane they took", and the tier-0 latency metric has no source.
CREATE TABLE IF NOT EXISTS incidents (
  id                 TEXT PRIMARY KEY,          -- inc-e/inc-s/inc-h id from incidentIdFor()
  scope              TEXT NOT NULL,
  scope_key          TEXT NOT NULL,
  host               TEXT NOT NULL,
  stack_project      TEXT,
  primary_entity_id  TEXT NOT NULL,
  entity_ids         TEXT[] NOT NULL DEFAULT '{}',
  tier               SMALLINT NOT NULL,
  lane               TEXT NOT NULL,
  state              TEXT NOT NULL,
  occurrence         INTEGER NOT NULL DEFAULT 1,
  signal_count       INTEGER NOT NULL DEFAULT 0,
  opened_at          TIMESTAMPTZ NOT NULL,
  first_signal_at    TIMESTAMPTZ NOT NULL,
  last_signal_at     TIMESTAMPTZ NOT NULL,
  dispatched_at      TIMESTAMPTZ,
  dispatch_outcome   TEXT,
  dispatch_detail    TEXT NOT NULL DEFAULT '',
  latency_ms         INTEGER,
  deciding_rule_id   TEXT,
  rule_ids           TEXT[] NOT NULL DEFAULT '{}',
  shape_ids          TEXT[] NOT NULL DEFAULT '{}',
  hard_signal        BOOLEAN NOT NULL DEFAULT FALSE,
  signals            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- bounded summary, <= 50 entries
  merged_from        TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT incidents_scope_check CHECK (scope IN ('container', 'stack', 'host')),
  CONSTRAINT incidents_lane_check CHECK (lane IN ('page', 'triage')),
  CONSTRAINT incidents_state_check CHECK (state IN ('open', 'dispatched', 'closed')),
  CONSTRAINT incidents_tier_check CHECK (tier BETWEEN 0 AND 2),
  CONSTRAINT incidents_outcome_check CHECK (dispatch_outcome IS NULL OR dispatch_outcome IN
    ('accepted','duplicate','rate-limited','rejected','transport','circuit-open',
     'budget-exhausted','queue-dropped','disabled','cooldown','page-sent'))
);

CREATE INDEX IF NOT EXISTS idx_incidents_time ON incidents (first_signal_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_entities ON incidents USING GIN (entity_ids);
CREATE INDEX IF NOT EXISTS idx_incidents_t0_latency ON incidents (dispatched_at DESC)
  WHERE tier = 0 AND dispatched_at IS NOT NULL;

-- findings.incident_ids and entity_ids have no index today; the audit and list_incidents both need one.
CREATE INDEX IF NOT EXISTS idx_findings_incident_ids ON findings USING GIN (incident_ids);
CREATE INDEX IF NOT EXISTS idx_findings_entity_ids ON findings USING GIN (entity_ids);

-- Lane-change provenance. Written by a trigger, not by application code: lane changes reach
-- log_shapes through both recordShapeOccurrence's ON CONFLICT path and setShapeLane, and an
-- app-side write would miss one of them. A trigger cannot be bypassed.
CREATE TABLE IF NOT EXISTS log_shape_lane_history (
  id          BIGSERIAL PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  shape_id    TEXT NOT NULL,
  from_lane   TEXT,
  to_lane     TEXT NOT NULL,
  lane_source TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lane_history_lookup
  ON log_shape_lane_history (entity_id, shape_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_lane_history_time ON log_shape_lane_history (at DESC);

CREATE OR REPLACE FUNCTION record_log_shape_lane_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO log_shape_lane_history (entity_id, shape_id, from_lane, to_lane, lane_source, at)
    VALUES (NEW.entity_id, NEW.shape_id, NULL, NEW.lane, NEW.lane_source, NEW.lane_updated_at);
  ELSE
    INSERT INTO log_shape_lane_history (entity_id, shape_id, from_lane, to_lane, lane_source, at)
    VALUES (NEW.entity_id, NEW.shape_id, OLD.lane, NEW.lane, NEW.lane_source, NEW.lane_updated_at);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_shapes_lane_history_ins AFTER INSERT ON log_shapes
  FOR EACH ROW EXECUTE FUNCTION record_log_shape_lane_change();
CREATE TRIGGER log_shapes_lane_history_upd AFTER UPDATE ON log_shapes
  FOR EACH ROW WHEN (OLD.lane IS DISTINCT FROM NEW.lane)
  EXECUTE FUNCTION record_log_shape_lane_change();

-- Rule state history. Nothing writes this in phase 3; the phase-4 promotion engine does. It is
-- created now so the promoted/demoted metric has a stable source and reads zero honestly instead
-- of being absent, and so provenance for a demotion the audit names has somewhere to live.
CREATE TABLE IF NOT EXISTS detector_rule_transitions (
  id           BIGSERIAL PRIMARY KEY,
  rule_id      TEXT NOT NULL REFERENCES detector_rules(id) ON DELETE CASCADE,
  rule_version INTEGER NOT NULL,
  from_state   TEXT,
  to_state     TEXT NOT NULL,
  from_lane    TEXT,
  to_lane      TEXT,
  direction    TEXT NOT NULL,
  actor        TEXT NOT NULL,
  actor_id     TEXT,
  run_id       TEXT,
  rationale    TEXT NOT NULL DEFAULT '',
  gate         JSONB NOT NULL DEFAULT '{}'::jsonb,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT drt_direction_check
    CHECK (direction IN ('authoring', 'promotion', 'demotion', 'retirement', 'rejection')),
  CONSTRAINT drt_actor_check CHECK (actor IN ('operator', 'agent', 'auto', 'seed'))
);
CREATE INDEX IF NOT EXISTS idx_drt_time ON detector_rule_transitions (at DESC);
CREATE INDEX IF NOT EXISTS idx_drt_rule ON detector_rule_transitions (rule_id, at DESC);

-- Rollback:
-- DROP TRIGGER IF EXISTS log_shapes_lane_history_upd ON log_shapes;
-- DROP TRIGGER IF EXISTS log_shapes_lane_history_ins ON log_shapes;
-- DROP FUNCTION IF EXISTS record_log_shape_lane_change();
-- DROP TABLE IF EXISTS detector_rule_transitions;
-- DROP TABLE IF EXISTS log_shape_lane_history;
-- DROP INDEX IF EXISTS idx_findings_entity_ids;
-- DROP INDEX IF EXISTS idx_findings_incident_ids;
-- DROP TABLE IF EXISTS incidents;
-- DROP TABLE IF EXISTS reported_misses;
-- DROP VIEW IF EXISTS finding_training_labels;
-- DROP VIEW IF EXISTS finding_weak_signals;
-- DROP VIEW IF EXISTS finding_label_current;
-- DROP TABLE IF EXISTS finding_labels;
