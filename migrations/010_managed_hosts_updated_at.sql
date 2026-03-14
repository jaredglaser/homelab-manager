-- Add updated_at column to managed_hosts table for agent bootstrap tracking
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
