// reported_misses and incidents share one migration and one set of read paths (attributeMiss
// joins both), so both repositories live in reported-incident-repository.ts. This file exists
// only so callers can name the miss half of that module the way the rest of the feedback layer
// refers to it.
export { ReportedMissRepository, MISS_STATUSES, ATTRIBUTION_VERDICTS, MAX_MISS_WHAT_HAPPENED_CHARS, MAX_MISS_ENTITY_IDS } from './reported-incident-repository';
export type { MissStatus, AttributionVerdict, ReportedMiss, CreateReportedMissInput, ListMissesOptions } from './reported-incident-repository';
