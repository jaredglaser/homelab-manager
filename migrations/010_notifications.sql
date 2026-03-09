CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_undismissed
  ON notifications (created_at DESC) WHERE dismissed = FALSE;
