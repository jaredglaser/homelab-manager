-- Generic downsampling and cleanup functions
-- Works with any source/type combination automatically

-- ============================================================================
-- DOWNSAMPLE RAW -> AGGREGATE
-- ============================================================================

-- Downsample raw data to aggregate table at a given granularity
-- Processes data in a 1-day window older than the age threshold
CREATE OR REPLACE FUNCTION downsample_raw_to_agg(
  p_age_threshold INTERVAL,
  p_granularity VARCHAR(10)
)
RETURNS INTEGER AS $$
DECLARE
  rows_processed INTEGER := 0;
BEGIN
  INSERT INTO stats_agg (
    period_start, period_end,
    source_id, type_id, entity,
    min_value, avg_value, max_value, sample_count,
    granularity
  )
  SELECT
    MIN(timestamp) AS period_start,
    MAX(timestamp) AS period_end,
    source_id,
    type_id,
    entity,
    MIN(value),
    AVG(value),
    MAX(value),
    COUNT(*)::INT,
    p_granularity
  FROM stats_raw
  WHERE timestamp < NOW() - p_age_threshold
    AND timestamp >= NOW() - p_age_threshold - INTERVAL '1 day'
  GROUP BY date_trunc(p_granularity, timestamp), source_id, type_id, entity
  ON CONFLICT (granularity, period_start, source_id, type_id, entity) DO NOTHING;

  GET DIAGNOSTICS rows_processed = ROW_COUNT;

  -- Delete processed raw data
  DELETE FROM stats_raw
  WHERE timestamp < NOW() - p_age_threshold
    AND timestamp >= NOW() - p_age_threshold - INTERVAL '1 day';

  RAISE NOTICE 'raw -> %: processed % rows', p_granularity, rows_processed;
  RETURN rows_processed;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- DOWNSAMPLE AGGREGATE -> AGGREGATE
-- ============================================================================

-- Re-aggregate from one granularity to another (e.g., minute -> hour)
-- Uses weighted averaging for statistically correct results
CREATE OR REPLACE FUNCTION downsample_agg_to_agg(
  p_source_granularity VARCHAR(10),
  p_target_granularity VARCHAR(10),
  p_age_threshold INTERVAL
)
RETURNS INTEGER AS $$
DECLARE
  rows_processed INTEGER := 0;
BEGIN
  INSERT INTO stats_agg (
    period_start, period_end,
    source_id, type_id, entity,
    min_value, avg_value, max_value, sample_count,
    granularity
  )
  SELECT
    MIN(period_start) AS period_start,
    MAX(period_end) AS period_end,
    source_id,
    type_id,
    entity,
    MIN(min_value),
    SUM(avg_value * sample_count) / NULLIF(SUM(sample_count), 0),
    MAX(max_value),
    SUM(sample_count)::INT,
    p_target_granularity
  FROM stats_agg
  WHERE granularity = p_source_granularity
    AND period_start < NOW() - p_age_threshold
    AND period_start >= NOW() - p_age_threshold - INTERVAL '1 day'
  GROUP BY date_trunc(p_target_granularity, period_start), source_id, type_id, entity
  ON CONFLICT (granularity, period_start, source_id, type_id, entity) DO NOTHING;

  GET DIAGNOSTICS rows_processed = ROW_COUNT;

  -- Delete processed source granularity data
  DELETE FROM stats_agg
  WHERE granularity = p_source_granularity
    AND period_start < NOW() - p_age_threshold
    AND period_start >= NOW() - p_age_threshold - INTERVAL '1 day';

  RAISE NOTICE '% -> %: processed % rows', p_source_granularity, p_target_granularity, rows_processed;
  RETURN rows_processed;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- CLEANUP FUNCTION
-- ============================================================================

-- Delete old data that has already been downsampled
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
DECLARE
  raw_deleted INTEGER;
  minute_deleted INTEGER;
  hour_deleted INTEGER;
BEGIN
  -- Delete raw data older than 7 days
  DELETE FROM stats_raw WHERE timestamp < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS raw_deleted = ROW_COUNT;

  -- Delete minute aggregates older than 14 days
  DELETE FROM stats_agg WHERE granularity = 'minute' AND period_start < NOW() - INTERVAL '14 days';
  GET DIAGNOSTICS minute_deleted = ROW_COUNT;

  -- Delete hour aggregates older than 30 days
  DELETE FROM stats_agg WHERE granularity = 'hour' AND period_start < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS hour_deleted = ROW_COUNT;

  -- Daily data kept forever

  RAISE NOTICE 'Cleanup: raw=%, minute=%, hour=%', raw_deleted, minute_deleted, hour_deleted;
END;
$$ LANGUAGE plpgsql;
