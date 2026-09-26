export const AUTO_UPDATE_ENV = 'HLM_AUTO_UPDATE';

/**
 * Parse the HLM_AUTO_UPDATE value. Unset defaults to false: an agent with no
 * explicit setting must never update automatically. Only the exact strings
 * 'true' and 'false' are accepted; anything else is an error so a typo can
 * never silently turn automatic updates on.
 */
export function parseAutoUpdate(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}
