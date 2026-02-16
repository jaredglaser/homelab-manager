/**
 * Cleanup script (simplified for InfluxDB)
 *
 * InfluxDB handles data retention natively via bucket retention policies.
 * The retention period is configured via INFLUXDB_RETENTION env var
 * (default: 30 days) and is enforced automatically by InfluxDB.
 *
 * This script is kept for backwards compatibility but no longer performs
 * downsampling or data deletion — InfluxDB handles it all.
 *
 * Usage: bun run cleanup
 */
async function runCleanup() {
  console.log('[Cleanup] InfluxDB handles retention automatically via bucket retention policies.');
  console.log('[Cleanup] No manual downsampling or cleanup needed.');
  console.log('[Cleanup] To adjust retention, change the INFLUXDB_RETENTION environment variable.');
  process.exit(0);
}

runCleanup();
