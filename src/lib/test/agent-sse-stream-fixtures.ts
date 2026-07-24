/**
 * Shared test fixtures for the worker's agent-SSE-backed collectors
 * (AgentStatsCollector, ZFSCollector, ContainerInventoryCollector). All three
 * take an injectable `connectAgentSseStream`-shaped connector; these helpers
 * build one from a fixed list of already-parsed frames instead of standing up
 * a real byte-level SSE stream.
 */

/** Shape of the injectable connector each streaming collector accepts. */
export type StreamConnector = (options: {
  agentUrl: string;
  path: string;
  signer: () => Promise<string>;
  signal: AbortSignal;
}) => Promise<AsyncGenerator<unknown, void, void>>;

/** Wrap a fixed list of already-parsed frames as a stream connector. */
export function fixedStream(frames: unknown[]): StreamConnector {
  return async function* () {
    for (const frame of frames) yield frame;
  } as unknown as StreamConnector;
}
