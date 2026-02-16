import { Point } from '@influxdata/influxdb-client';
import type { InfluxDB, QueryApi, WriteApi } from '@influxdata/influxdb-client';
import type { RawStatRow, LatestStatRow } from './stats-repository';

/**
 * InfluxDB-backed repository for time-series stats.
 * Replaces PostgreSQL stats_raw/stats_agg tables with InfluxDB buckets.
 *
 * Data model:
 *   Measurement: "stats"
 *   Tags: source, type, entity
 *   Fields: value (float)
 *   Timestamp: millisecond precision
 */
export class InfluxStatsRepository {
  private writeApi: WriteApi;
  private queryApi: QueryApi;

  constructor(
    influxClient: InfluxDB,
    org: string,
    private bucket: string,
  ) {
    // Use millisecond precision to match JavaScript Date
    this.writeApi = influxClient.getWriteApi(org, bucket, 'ms', {
      batchSize: 500,
      flushInterval: 1000,
      maxRetries: 3,
      retryJitter: 200,
    });
    this.queryApi = influxClient.getQueryApi(org);
  }

  /**
   * Write raw stats to InfluxDB.
   * Converts RawStatRow[] to InfluxDB Points and writes them.
   */
  async insertRawStats(rows: RawStatRow[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const points = rows.map(row =>
        new Point('stats')
          .tag('source', row.source)
          .tag('type', row.type)
          .tag('entity', row.entity)
          .floatField('value', row.value)
          .timestamp(row.timestamp)
      );

      this.writeApi.writePoints(points);
      await this.writeApi.flush();
    } catch (err) {
      console.error('[InfluxStatsRepository] Failed to insert stats:', err);
      throw err;
    }
  }

  /**
   * Get the most recent stats for each entity/type combination.
   * Used by the subscription service to populate cache.
   */
  async getLatestStats(params: {
    sourceName: string;
    maxAge?: number; // Seconds, default 5
  }): Promise<LatestStatRow[]> {
    const maxAge = params.maxAge ?? 5;
    const source = escapeFluxString(params.sourceName);

    const query = `
      from(bucket: "${escapeFluxString(this.bucket)}")
        |> range(start: -${maxAge}s)
        |> filter(fn: (r) => r._measurement == "stats" and r.source == "${source}")
        |> last()
    `;

    try {
      const rows = await this.queryApi.collectRows<FluxRow>(query);
      return rows.map(row => ({
        timestamp: new Date(row._time),
        type: row.type,
        entity: row.entity,
        value: typeof row._value === 'number' ? row._value : parseFloat(String(row._value)),
      }));
    } catch (err) {
      console.error('[InfluxStatsRepository] Failed to get latest stats:', err);
      throw err;
    }
  }

  /**
   * Get distinct entities for a given source within a time range.
   */
  async getEntities(
    sourceName: string,
    daysBack: number = 7,
  ): Promise<string[]> {
    const source = escapeFluxString(sourceName);

    const query = `
      import "influxdata/influxdb/schema"
      schema.tagValues(
        bucket: "${escapeFluxString(this.bucket)}",
        tag: "entity",
        predicate: (r) => r._measurement == "stats" and r.source == "${source}",
        start: -${daysBack}d
      )
    `;

    try {
      const rows = await this.queryApi.collectRows<{ _value: string }>(query);
      return rows.map(r => r._value).sort();
    } catch (err) {
      console.error('[InfluxStatsRepository] Failed to get entities:', err);
      throw err;
    }
  }

  /**
   * Get time series stats for charting.
   * Returns data points for all entities matching the optional filter.
   */
  async getTimeSeriesStats(params: {
    sourceName: string;
    startTime: Date;
    endTime: Date;
    typeNames: string[];
    entityFilter?: (entity: string) => boolean;
  }): Promise<LatestStatRow[]> {
    const source = escapeFluxString(params.sourceName);
    const startTime = params.startTime.toISOString();
    const endTime = params.endTime.toISOString();

    // Build type filter
    const typeFilter = params.typeNames
      .map(t => `r.type == "${escapeFluxString(t)}"`)
      .join(' or ');

    const query = `
      from(bucket: "${escapeFluxString(this.bucket)}")
        |> range(start: ${startTime}, stop: ${endTime})
        |> filter(fn: (r) => r._measurement == "stats" and r.source == "${source}")
        |> filter(fn: (r) => ${typeFilter})
        |> sort(columns: ["_time"])
    `;

    try {
      const rows = await this.queryApi.collectRows<FluxRow>(query);

      let result: LatestStatRow[] = rows.map(row => ({
        timestamp: new Date(row._time),
        type: row.type,
        entity: row.entity,
        value: typeof row._value === 'number' ? row._value : parseFloat(String(row._value)),
      }));

      if (params.entityFilter) {
        result = result.filter(row => params.entityFilter!(row.entity));
      }

      return result;
    } catch (err) {
      console.error('[InfluxStatsRepository] Failed to get time series stats:', err);
      throw err;
    }
  }

  /**
   * Get stats for a specific entity within a time range.
   */
  async getStats(params: {
    sourceName: string;
    entity: string;
    startTime: Date;
    endTime: Date;
    typeNames?: string[];
  }): Promise<LatestStatRow[]> {
    const source = escapeFluxString(params.sourceName);
    const entity = escapeFluxString(params.entity);
    const startTime = params.startTime.toISOString();
    const endTime = params.endTime.toISOString();

    let typeFilter = '';
    if (params.typeNames && params.typeNames.length > 0) {
      const types = params.typeNames
        .map(t => `r.type == "${escapeFluxString(t)}"`)
        .join(' or ');
      typeFilter = `|> filter(fn: (r) => ${types})`;
    }

    const query = `
      from(bucket: "${escapeFluxString(this.bucket)}")
        |> range(start: ${startTime}, stop: ${endTime})
        |> filter(fn: (r) => r._measurement == "stats" and r.source == "${source}" and r.entity == "${entity}")
        ${typeFilter}
        |> sort(columns: ["_time"], desc: true)
    `;

    try {
      const rows = await this.queryApi.collectRows<FluxRow>(query);
      return rows.map(row => ({
        timestamp: new Date(row._time),
        type: row.type,
        entity: row.entity,
        value: typeof row._value === 'number' ? row._value : parseFloat(String(row._value)),
      }));
    } catch (err) {
      console.error('[InfluxStatsRepository] Failed to get stats:', err);
      throw err;
    }
  }

  /**
   * Flush any buffered writes and close the write API.
   */
  async close(): Promise<void> {
    try {
      await this.writeApi.close();
    } catch (err) {
      console.error('[InfluxStatsRepository] Error closing write API:', err);
    }
  }
}

/** Row shape returned by Flux queries */
interface FluxRow {
  _time: string;
  _value: number | string;
  _field: string;
  _measurement: string;
  source: string;
  type: string;
  entity: string;
}

/**
 * Escape a string for safe use in Flux query strings.
 * Prevents injection by escaping backslashes and double quotes.
 */
function escapeFluxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
