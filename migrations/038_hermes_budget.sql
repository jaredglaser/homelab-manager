-- Daily dispatch budget for the Hermes push path.
--
-- Hermes bounds nothing on its side: the webhook adapter spawns a detached task per
-- delivery with no semaphore, so this counter is the only ceiling on how much a signal
-- storm can spend. Holding it in process memory meant a crash-looping worker re-spent
-- the whole day's allocation on every restart, which is exactly the situation the
-- ceiling exists for.
--
-- One row per (day, bucket). Buckets are the three criticality tiers plus the
-- zero-LLM page lane, which is counted separately because it costs a notification
-- rather than an agent run.

CREATE TABLE IF NOT EXISTS hermes_budget (
  day    DATE NOT NULL,
  bucket TEXT NOT NULL,
  spent  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket),
  CONSTRAINT hermes_budget_bucket_check CHECK (bucket IN ('t0', 't1', 't2', 'page')),
  CONSTRAINT hermes_budget_spent_non_negative CHECK (spent >= 0)
);
