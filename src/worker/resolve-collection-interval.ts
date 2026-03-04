import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import type { SettingsRepository } from '@/lib/database/repositories/settings-repository';

const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 60_000;

/**
 * Read the collection interval from database settings, falling back to the default.
 * Returns the DB value if it's a valid integer in [100, 60000], otherwise `defaultInterval`.
 * Swallows DB errors gracefully - the worker should always start.
 */
export async function resolveCollectionInterval(
  settingsRepo: SettingsRepository,
  defaultInterval: number,
): Promise<number> {
  try {
    const raw = await settingsRepo.get(SETTINGS_KEYS.general.updateIntervalMs);
    if (raw === null) return defaultInterval;

    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS && parsed <= MAX_INTERVAL_MS) {
      return parsed;
    }

    return defaultInterval;
  } catch {
    return defaultInterval;
  }
}
