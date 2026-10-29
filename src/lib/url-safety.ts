/**
 * True when a URL is a plain http(s) URL. Any href rendered from untrusted
 * data (registry release metadata, markdown link targets) must pass this
 * check first, so other schemes never reach an href.
 */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}
