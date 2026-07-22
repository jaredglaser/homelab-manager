import { createSseStream } from '@/lib/sse/create-sse-stream';
import type { StatsSource } from '@/lib/database/subscription-service';

/**
 * Factory for stats SSE route handlers.
 * All three stats endpoints (docker, zfs, proxmox) share identical logic;
 * only the source string differs. Wire mechanics (headers, flush,
 * heartbeat, abort teardown) live in `createSseStream`; StatsPollService
 * only pushes rows when it has new ones, so before the shared heartbeat
 * this stream stayed silent (past idle timeouts) whenever the worker was
 * down.
 */
export function createStatsSseHandler(source: StatsSource) {
  return async ({ request }: { request: Request }) => {
    const { authenticateSSE } = await import('@/lib/auth/sse-auth');
    const user = await authenticateSSE(request);
    if (!user) {
      return new Response('Unauthorized', { status: 401 });
    }

    await import('@/lib/server-init');
    const { statsPollService } = await import(
      '@/lib/database/subscription-service'
    );

    return createSseStream(request, {
      onStart: (emit) => {
        try {
          return statsPollService.subscribe(
            source,
            (rows) => emit.data(rows),
            () => emit.event('stats_error', {}),
          );
        } catch {
          // Subscribe is unrecoverable for this request: end the stream
          // now rather than leaving it open with nothing left to send.
          emit.event('stats_error', {});
          emit.close();
        }
      },
    });
  };
}
