import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';

const DEFAULT_RAW_DATA_HOURS = 1;
const DEFAULT_MINUTE_AGG_DAYS = 3;
const DEFAULT_HOUR_AGG_DAYS = 30;

/**
 * Downsampling and cleanup script
 * Runs hourly to aggregate old data and maintain retention policy
 *
 * Usage: bun run cleanup
 * Schedule with cron: 0 * * * * cd /app && bun run cleanup
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

    // Read retention settings from DB (fall back to defaults)
    const settings = new SettingsRepository(pool);
    const allSettings = await settings.getAll();

    const rawHours = parseInt(allSettings.get('retention/rawDataHours') ?? '', 10) || DEFAULT_RAW_DATA_HOURS;
    const minuteDays = parseInt(allSettings.get('retention/minuteAggDays') ?? '', 10) || DEFAULT_MINUTE_AGG_DAYS;
    const hourDays = parseInt(allSettings.get('retention/hourAggDays') ?? '', 10) || DEFAULT_HOUR_AGG_DAYS;

    console.log(`[Cleanup] Retention: raw=${rawHours}h, minute=${minuteDays}d, hour=${hourDays}d`);

    // Run downsampling: raw -> minute
    console.log('[Cleanup] Downsampling raw -> minute...');
    const minuteResult = await pool.query(
      `SELECT downsample_raw_to_agg($1::INTERVAL, 'minute')`,
      [`${rawHours} hours`]
    );
    console.log(`[Cleanup] raw->minute: ${minuteResult.rows[0]?.downsample_raw_to_agg || 0} rows`);

    // Run downsampling: minute -> hour
    console.log('[Cleanup] Downsampling minute -> hour...');
    const hourResult = await pool.query(
      `SELECT downsample_agg_to_agg('minute', 'hour', $1::INTERVAL)`,
      [`${minuteDays} days`]
    );
    console.log(`[Cleanup] minute->hour: ${hourResult.rows[0]?.downsample_agg_to_agg || 0} rows`);

    // Run downsampling: hour -> day
    console.log('[Cleanup] Downsampling hour -> day...');
    const dayResult = await pool.query(
      `SELECT downsample_agg_to_agg('hour', 'day', $1::INTERVAL)`,
      [`${hourDays} days`]
    );
    console.log(`[Cleanup] hour->day: ${dayResult.rows[0]?.downsample_agg_to_agg || 0} rows`);

    // Cleanup old data (parameterized to match retention settings)
    console.log('[Cleanup] Deleting old data...');
    await pool.query(
      'DELETE FROM stats_raw WHERE timestamp < NOW() - $1::INTERVAL',
      [`${rawHours} hours`]
    );
    await pool.query(
      "DELETE FROM stats_agg WHERE granularity = 'minute' AND period_start < NOW() - $1::INTERVAL",
      [`${minuteDays} days`]
    );
    await pool.query(
      "DELETE FROM stats_agg WHERE granularity = 'hour' AND period_start < NOW() - $1::INTERVAL",
      [`${hourDays} days`]
    );

    // Close connections
    await databaseConnectionManager.closeAll();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Cleanup] Completed successfully in ${duration}s`);
    process.exit(0);
  } catch (err) {
    console.error('[Cleanup] Error:', err);
    process.exit(1);
  }
}

// Run cleanup
runCleanup();
