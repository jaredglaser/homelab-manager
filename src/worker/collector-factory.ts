/**
 * Rewrite localhost agent URLs so the worker container can reach agents
 * on the same Docker network. Uses WORKER_LOCALHOST_AGENT env var as the
 * Docker-internal hostname (e.g. "hlm-agent"). Remote agent URLs
 * (e.g. 192.168.1.50:9090) pass through unchanged.
 */
export function resolveAgentUrl(url: string): string {
  const dockerHost = process.env.WORKER_LOCALHOST_AGENT;
  if (!dockerHost) return url;
  return url.replace(/:\/\/(\[?::1\]?|localhost|127\.0\.0\.1):/, `://${dockerHost}:`);
}
