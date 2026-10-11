// One home for mux wire timing: the keepalive ping cadence and the reconnect
// backoff shared by the browser socket and the server agent-pipe retry.

export const PING_INTERVAL_MS = 25_000;
export const RECONNECT_BASE_BACKOFF_MS = 1_000;
export const RECONNECT_MAX_BACKOFF_MS = 16_000;
