/**
 * Shared type definitions for stats repositories.
 *
 * These types are used by both the InfluxDB stats repository (time-series)
 * and entity metadata repository (PostgreSQL), as well as transformers
 * and worker collectors.
 */

export interface RawStatRow {
  timestamp: Date;
  source: string;
  type: string;
  entity: string;
  value: number;
}

/** Row returned by getLatestStats - latest value for each entity/type combination */
export interface LatestStatRow {
  timestamp: Date;
  type: string;
  entity: string;
  value: number;
}
