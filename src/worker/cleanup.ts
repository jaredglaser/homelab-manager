import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';

/**
 * Downsampling and cleanup script
 * Runs daily to aggregate old data and maintain retention policy
 *
 * Usage: bun run cleanup
 * Schedule with cron: 0 2 * * * cd /app && bun run cleanup
 */
async function runCleanup() {
  console.log('[Cleanup] Starting downsampling job...');
  const startTime = Date.now();

  try {
    // Load configuration
    const dbConfig = loadDatabaseConfig();

    // Connect to database
    console.log('[Cleanup] Connecting to PostgreSQL...');
    const db = await databaseConnectionManager.getClient(dbConfig);
    const pool = db.getPool();

    // Run downsampling: raw -> minute (data older than 7 days)
    console.log('[Cleanup] Downsampling raw -> minute...');
    const minuteResult = await pool.query(
      "SELECT downsample_raw_to_agg('7 days'::INTERVAL, 'minute')"
    );
    console.log(`[Cleanup] raw->minute: ${minuteResult.rows[0]?.downsample_raw_to_agg || 0} rows`);

    // Run downsampling: minute -> hour (data older than 14 days)
    console.log('[Cleanup] Downsampling minute -> hour...');
    const hourResult = await pool.query(
      "SELECT downsample_agg_to_agg('minute', 'hour', '14 days'::INTERVAL)"
    );
    console.log(`[Cleanup] minute->hour: ${hourResult.rows[0]?.downsample_agg_to_agg || 0} rows`);

    // Run downsampling: hour -> day (data older than 30 days)
    console.log('[Cleanup] Downsampling hour -> day...');
    const dayResult = await pool.query(
      "SELECT downsample_agg_to_agg('hour', 'day', '30 days'::INTERVAL)"
    );
    console.log(`[Cleanup] hour->day: ${dayResult.rows[0]?.downsample_agg_to_agg || 0} rows`);

    // Cleanup old data
    console.log('[Cleanup] Deleting old data...');
    await pool.query('SELECT cleanup_old_data()');

    // Close connections
    await databaseConnectionManager.closeAll();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Cleanup] ✓ Completed successfully in ${duration}s`);
    process.exit(0);
  } catch (err) {
    console.error('[Cleanup] ✗ Error:', err);
    process.exit(1);
  }
}

// Run cleanup
runCleanup();
