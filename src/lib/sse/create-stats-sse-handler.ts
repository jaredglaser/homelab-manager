import { createSseStream } from '@/lib/sse/create-sse-stream';
import type { StatsSource } from '@/lib/database/subscription-service';

/**
 * Factory for stats SSE route handlers (docker, zfs, proxmox share this; only the source differs).
 * StatsPollService only pushes on new rows, so the shared `createSseStream` heartbeat is what
 * keeps this stream alive when the worker is down and nothing new ever arrives.
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
          emit.event('stats_error', {});
          emit.close();
        }
      },
    });
  };
}
