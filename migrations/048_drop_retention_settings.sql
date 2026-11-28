-- Retention periods are fixed in code. The server rejects writes to these keys, so a leftover row would only ride the settings init frame.
DELETE FROM settings WHERE key IN (
  'retention/rawDataHours',
  'retention/minuteAggDays',
  'retention/hourAggDays'
);
