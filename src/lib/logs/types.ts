export type LogLane = 'page' | 'triage' | 'batch' | 'count';
export type Tier = 0 | 1 | 2;
export type LogStream = 'stdout' | 'stderr';

export const LOG_LANES: readonly LogLane[] = ['page', 'triage', 'batch', 'count'] as const;

export const LANE_SEVERITY: Readonly<Record<LogLane, number>> = {
  count: 0,
  batch: 1,
  triage: 2,
  page: 3,
} as const;
