export const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

export async function fetchWithRetry(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  // Transient GitHub failures (429, 5xx, network) retry with exponential
  // backoff; a deterministic 4xx fails on the first attempt so callers see
  // the real error instead of a 30s ladder before it.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      console.warn(
        `fetch ${url} network error (attempt ${attempt + 1}); retrying: ${err instanceof Error ? err.message : err}`,
      );
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (res.ok || !(res.status === 429 || res.status >= 500)) return res;
    if (attempt >= RETRY_DELAYS_MS.length) return res;
    const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 0, 60);
    const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt];
    console.warn(`fetch ${url} HTTP ${res.status} (attempt ${attempt + 1}); retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}
