-- migrations/037_log_detection.sql
-- Phase 2 of the Hermes log-analysis plan (docs/hermes-log-analysis-plan.md, sections 5-6):
-- persistence for shape discovery, the batch-lane rollup, and the rule table the detection
-- engine (src/lib/logs/) reads. Nothing here opens a socket or calls Hermes; the dispatcher
-- and worker wiring are a later phase.
--
-- Container criticality tier is deliberately NOT a new table. Plan section 4.2: "Tier lives
-- on entity_metadata alongside icons and labels, keyed by entity id, so it survives redeploys
-- the same way the rest of that table does." entity_metadata (migration 002) is a generic
-- (source, entity, key) -> value store with existing keys icon/service_key/name/image/label;
-- criticality fits as a new key value ('criticality', values '0'|'1'|'2') on the existing
-- entity = host/container_id row, with no schema change and no new table.
--
-- log_shapes carries one row per (entity, shapeId): the running total, first/last seen and
-- current lane. It is meant to stay a plain table sized at (entity count x
-- <=MAX_SHAPES_PER_ENTITY = 500, src/lib/logs/shape.ts), not a hypertable, on the assumption
-- that per-entity shape cardinality is bounded. That budget is not enforced anywhere yet:
-- recordShapeOccurrence inserts unconditionally, and the worker that would count shapes per
-- entity and fold new ones past it (coarsenTemplate exists for this) has not been built. A
-- source with genuinely unbounded per-line cardinality grows this table without limit until
-- that enforcement lands.
--
-- log_shape_buckets is the volume table: one row per (entity, shapeId, hour) accumulating
-- the batch lane. Unlike the stats cascade (migrations 002/030-032), this is not a
-- continuous aggregate over raw rows with a source-retention dependency: log_shapes above
-- already carries the all-time count and first/last-seen, written directly by the app on
-- every occurrence, independent of these buckets. log_shape_buckets exists only to serve the
-- batch digest's recent window (plan 5.3: "last 24h", occasionally a week), so an immediate
-- retention policy is safe here in a way it was not for docker_stats/zfs_stats (see the
-- gotcha in migration 007: those needed a backfill before retention could apply safely,
-- because their coarser tiers are continuous aggregates sourced from the raw table itself).
-- 30 days keeps a month of exemplar-level detail for review; the all-time count and first/
-- last-seen timestamps on log_shapes survive the drop.

CREATE TABLE IF NOT EXISTS log_shapes (
  entity_id        TEXT NOT NULL,
  shape_id         TEXT NOT NULL,
  template         TEXT NOT NULL,
  first_seen_at    TIMESTAMPTZ NOT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL,
  total_count      BIGINT NOT NULL DEFAULT 0,
  lane             TEXT NOT NULL DEFAULT 'count',
  lane_source      TEXT NOT NULL DEFAULT 'default',
  lane_updated_at  TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, shape_id),
  CONSTRAINT log_shapes_lane_check CHECK (lane IN ('page', 'triage', 'batch', 'count'))
);

CREATE INDEX IF NOT EXISTS idx_log_shapes_entity_lane ON log_shapes (entity_id, lane);
CREATE INDEX IF NOT EXISTS idx_log_shapes_last_seen ON log_shapes (last_seen_at);

CREATE TABLE IF NOT EXISTS log_shape_buckets (
  bucket_start  TIMESTAMPTZ NOT NULL,
  entity_id     TEXT NOT NULL,
  shape_id      TEXT NOT NULL,
  lane          TEXT NOT NULL,
  count         BIGINT NOT NULL DEFAULT 0,
  exemplars     JSONB NOT NULL DEFAULT '[]'::jsonb,
  numbers       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, shape_id, bucket_start),
  CONSTRAINT log_shape_buckets_lane_check CHECK (lane IN ('page', 'triage', 'batch', 'count'))
);

SELECT create_hypertable(
  'log_shape_buckets', 'bucket_start',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Range scan by entity + time (the digest's access pattern) needs its own index: the
-- primary key orders shape_id before bucket_start, which does not support "all shapes for
-- this entity in this window" without a per-shape lookup.
CREATE INDEX IF NOT EXISTS idx_log_shape_buckets_entity_time ON log_shape_buckets (entity_id, bucket_start DESC);

-- A plain btree index above only accelerates entity_id equality, not the host-scoped
-- digest's `entity_id LIKE 'host/%'` prefix match: under any non-"C" collation (the
-- database default), a btree can't use a LIKE prefix as a range bound unless the index
-- itself uses a pattern-matching operator class.
CREATE INDEX IF NOT EXISTS idx_log_shape_buckets_entity_prefix ON log_shape_buckets (entity_id text_pattern_ops, bucket_start DESC);

ALTER TABLE log_shape_buckets SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'entity_id, shape_id'
);

SELECT add_compression_policy('log_shape_buckets', INTERVAL '3 days', if_not_exists => TRUE);
SELECT add_retention_policy('log_shape_buckets', INTERVAL '30 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS detector_rules (
  id                          TEXT PRIMARY KEY,
  version                     INTEGER NOT NULL DEFAULT 1,
  name                        TEXT NOT NULL,
  kind                        TEXT NOT NULL,
  matcher                     JSONB NOT NULL,
  lane                        TEXT NOT NULL,
  state                       TEXT NOT NULL DEFAULT 'shadow',
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
  scope                       JSONB NOT NULL,
  applies_to_tiers            SMALLINT[],
  priority                    INTEGER NOT NULL DEFAULT 0,
  hard_signal                 BOOLEAN NOT NULL DEFAULT FALSE,
  operator_approved           BOOLEAN NOT NULL DEFAULT FALSE,
  canary_until                TIMESTAMPTZ,
  cooldown_ms                 INTEGER,
  origin                      TEXT NOT NULL,
  proposed_by_run_id          TEXT,
  proposed_from_finding_id    TEXT,
  rationale                   TEXT NOT NULL DEFAULT '',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at                 TIMESTAMPTZ,
  CONSTRAINT detector_rules_kind_check CHECK (kind IN ('match', 'threshold', 'route', 'silence', 'correlate', 'state')),
  CONSTRAINT detector_rules_lane_check CHECK (lane IN ('page', 'triage', 'batch', 'count')),
  CONSTRAINT detector_rules_state_check CHECK (state IN ('proposed', 'shadow', 'active', 'rejected', 'retired')),
  CONSTRAINT detector_rules_origin_check CHECK (origin IN ('seed', 'operator', 'agent'))
);

CREATE INDEX IF NOT EXISTS idx_detector_rules_evaluable ON detector_rules (state) WHERE enabled;

-- Seeded rules (plan section 6.4, spec section C.8). All fleet-scoped, active on arrival
-- (a seed is shipped policy, not an unreviewed proposal) and operator_approved so the
-- fleet-demotion clamp does not fight the design's own intentional demotions (e.g.
-- seed:level-warn routes to 'batch' on every tier, including tier 0, by design).
-- ON CONFLICT DO NOTHING keeps this idempotent against a rerun; it does not overwrite a
-- row an operator has since edited.
INSERT INTO detector_rules (
  id, version, name, kind, matcher, lane, state, enabled, scope, applies_to_tiers,
  priority, hard_signal, operator_approved, origin, rationale, promoted_at
) VALUES
  ('seed:level-fatal', 1, 'Fatal/critical level token', 'match',
   '{"type":"regex","pattern":"\\b(FATAL|CRITICAL|EMERG)\\b","flags":"","target":"raw","stream":"any"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'A fatal/critical level token means the process considers this condition unrecoverable; triage on every tier.', NOW()),

  ('seed:panic', 1, 'Panic / unhandled exception', 'match',
   '{"type":"regex","pattern":"\\bpanic:|\\b(?:PANIC|Unhandled exception|FATAL EXCEPTION)\\b","flags":"","target":"raw","stream":"any"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'A language-runtime panic or unhandled exception is a hard failure signature across Go, Java/Kotlin and Node.', NOW()),

  ('seed:traceback', 1, 'Python traceback', 'match',
   '{"type":"literal","needle":"Traceback (most recent call last)","caseSensitive":true,"target":"raw","stream":"any"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'The literal header CPython prints at the start of every uncaught exception.', NOW()),

  ('seed:segfault', 1, 'Segfault', 'match',
   '{"type":"regex","pattern":"\\b(segfault|SIGSEGV|Segmentation fault)\\b","flags":"","target":"raw","stream":"any"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'A native crash signature; always worth immediate investigation.', NOW()),

  ('seed:oom-log', 1, 'Out of memory (log line)', 'match',
   '{"type":"regex","pattern":"\\b(Out of memory|OutOfMemoryError|Cannot allocate memory|ENOMEM)\\b","flags":"","target":"raw","stream":"any"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'Memory exhaustion reported by the process itself, ahead of any kernel OOM kill event.', NOW()),

  ('seed:level-error-t0', 1, 'ERROR level token (tier 0)', 'match',
   '{"type":"regex","pattern":"\\b(ERROR|ERR)\\b","flags":"","target":"raw","stream":"any"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', '{0}',
   0, FALSE, TRUE, 'seed', 'On a critical container an ERROR line is worth immediate attention; the same token is routine noise at lower tiers (see seed:level-error).', NOW()),

  ('seed:level-error', 1, 'ERROR level token (standard/background)', 'match',
   '{"type":"regex","pattern":"\\b(ERROR|ERR)\\b","flags":"","target":"raw","stream":"any"}',
   'batch', 'active', TRUE, '{"kind":"fleet"}', '{1,2}',
   0, FALSE, TRUE, 'seed', 'ERROR is too common on non-critical containers to page on; roll it up for the batch digest instead.', NOW()),

  ('seed:level-warn', 1, 'WARN level token', 'match',
   '{"type":"regex","pattern":"\\bWARN(?:ING)?\\b","flags":"","target":"raw","stream":"any"}',
   'batch', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, FALSE, TRUE, 'seed', 'WARN is routine on every tier by default; the agent promotes specific warning shapes it judges significant via a route rule.', NOW()),

  ('seed:oom-killed', 1, 'OOM killed', 'state',
   '{"type":"event","eventTypes":["die"],"oomKilled":true}',
   'page', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'The kernel OOM-killed the container; page on tier 0, clamped to triage below it.', NOW()),

  ('seed:nonzero-exit', 1, 'Non-zero exit', 'state',
   '{"type":"event","eventTypes":["die"],"exitCodeNonZero":true}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'A container that exits non-zero failed by its own account.', NOW()),

  ('seed:crash-loop', 1, 'Crash loop (tier 0)', 'state',
   '{"type":"event","eventTypes":["start"],"minRestartsInWindow":3,"windowMs":600000}',
   'page', 'active', TRUE, '{"kind":"fleet"}', '{0}',
   0, TRUE, TRUE, 'seed', 'Three restarts in ten minutes on a critical container is a page-worthy failure, not routine flapping.', NOW()),

  ('seed:crash-loop-lower', 1, 'Crash loop (standard/background)', 'state',
   '{"type":"event","eventTypes":["start"],"minRestartsInWindow":3,"windowMs":600000}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', '{1,2}',
   0, TRUE, TRUE, 'seed', 'Same crash-loop signature as seed:crash-loop, one lane lower for non-critical containers.', NOW()),

  ('seed:health-failing', 1, 'Health check failing', 'state',
   '{"type":"event","eventTypes":["health_status"],"healthStatus":"unhealthy"}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'Docker''s own health check has already decided something is wrong.', NOW()),

  ('seed:stderr-burst', 1, 'Stderr rate burst', 'threshold',
   '{"type":"threshold","metric":"stderrCount","comparison":"zScore","value":4,"windowMs":60000}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, FALSE, TRUE, 'seed', 'Stderr volume significant against this entity''s adaptive baseline (z >= 4, see src/lib/logs/baseline.ts).', NOW()),

  ('seed:line-burst', 1, 'Line rate burst', 'threshold',
   '{"type":"threshold","metric":"lineCount","comparison":"zScore","value":4,"windowMs":60000}',
   'batch', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, FALSE, TRUE, 'seed', 'Overall line volume significant against baseline, but not on its own worth an interactive run; the digest surfaces it.', NOW()),

  ('seed:silence', 1, 'Unexpected silence', 'silence',
   '{"type":"silence","windowMs":300000}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', '{0,1}',
   0, FALSE, TRUE, 'seed', 'A container that normally logs has gone quiet for 5 minutes; only evaluated where the container''s expected rate clears the floor (see evaluateSilence).', NOW()),

  ('seed:post-deploy-error-burst', 1, 'Post-deploy stderr burst', 'threshold',
   '{"type":"threshold","metric":"stderrCount","comparison":"baselineMultiple","value":2,"windowMs":120000,"sinceImageChangeMaxMs":900000}',
   'triage', 'active', TRUE, '{"kind":"fleet"}', NULL,
   0, TRUE, TRUE, 'seed', 'Watches the post-deploy window (ctx.sinceImageChangeMs < 15m) for a stderr rate above 2x the pre-deploy baseline; hardSignal so it survives the cold start its own image change created.', NOW())
ON CONFLICT (id) DO NOTHING;
