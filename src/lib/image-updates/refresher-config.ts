export const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60_000;

export interface ImageUpdateRefresherConfig {
  intervalMs: number;
}

export function parseIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_REFRESH_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      'IMAGE_UPDATE_REFRESH_INTERVAL_MS must be a positive integer number of milliseconds, got "' + (raw ?? '') + '".',
    );
  }
  return parsed;
}

export function loadImageUpdateRefresherConfig(env: Record<string, string | undefined> = process.env): ImageUpdateRefresherConfig {
  return { intervalMs: parseIntervalMs(env.IMAGE_UPDATE_REFRESH_INTERVAL_MS) };
}

/** Rows older than twice the interval are stale enough for reads to fall back to live checks. */
export function staleThresholdMs(config: ImageUpdateRefresherConfig): number {
  return config.intervalMs * 2;
}
