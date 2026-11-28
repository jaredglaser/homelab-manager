-- No foreign key to users: with AUTH_DISABLED the synthetic admin (id 0) owns its settings and has no users row.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER NOT NULL,
  key        VARCHAR(255) NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

-- These display preferences moved to user_settings. Every user starts from the code defaults.
DELETE FROM settings WHERE key IN (
  'general/use12HourTime',
  'general/showSparklines',
  'general/useAbbreviatedUnits',
  'general/lightPalette',
  'docker/memoryDisplayMode',
  'docker/chartWindowSeconds',
  'docker/decimals/cpu',
  'docker/decimals/memory',
  'docker/decimals/diskSpeed',
  'docker/decimals/networkSpeed',
  'zfs/decimals/diskSpeed',
  'developer/sseDebugLogging'
);
