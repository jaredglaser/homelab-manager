import { createSseStream } from '@/lib/sse/create-sse-stream';
import type { StatsSource } from '@/lib/database/subscription-service';

// Structural, not the full SseChannelDescriptor, so this module doesn't need to import zod.
interface StatsChannel {
  errorEvent: string;
}

/**
 * Factory for stats SSE route handlers (docker/zfs/proxmox share identical logic; only
 * the source and channel descriptor differ). StatsPollService only pushes rows when it
 * has new ones, so without the shared heartbeat in `createSseStream` this stream stayed
 * silent (past idle timeouts) whenever the worker was down.
 */
export function createStatsSseHandler(source: StatsSource, channel: StatsChannel) {
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
            () => emit.event(channel.errorEvent, {}),
          );
        } catch {
          // Subscribe is unrecoverable for this request: end the stream
          // now rather than leaving it open with nothing left to send.
          emit.event(channel.errorEvent, {});
          emit.close();
        }
      },
    });
  };
}
