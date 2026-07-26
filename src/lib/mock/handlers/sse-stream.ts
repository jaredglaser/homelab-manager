/**
 * Helpers for emitting Server-Sent Events from MSW handlers. The real backend
 * streams `text/event-stream` frames; these mirror that wire format so the app's
 * `useEventSource` hook and the native `EventSource` parse them unchanged.
 */

/** Format a default (unnamed) `message` frame carrying a JSON payload. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Format a named event frame (e.g. `backlog_done`) carrying a JSON payload. */
export function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

/**
 * Control surface handed to a stream producer. `send`/`sendEvent` enqueue frames;
 * `interval` registers a repeating emitter that is cleared automatically when the
 * consumer (EventSource) disconnects, so demo streams never leak timers.
 */
export interface SseController {
  send: (payload: unknown) => void;
  sendEvent: (event: string, payload: unknown) => void;
  interval: (ms: number, tick: () => void) => void;
}

/**
 * Build a streaming `Response` whose body is driven by `produce`. The producer
 * runs once when the stream opens; any timers it registers via `controller.interval`
 * are torn down on cancel (tab close, navigation, or hook cleanup).
 */
export function createSseResponse(produce: (controller: SseController) => void): Response {
  const encoder = new TextEncoder();
  const timers = new Set<ReturnType<typeof setInterval>>();
  let closed = false;

  const teardown = () => {
    closed = true;
    for (const id of timers) clearInterval(id);
    timers.clear();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const enqueue = (frame: string) => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(frame));
        } catch {
          teardown();
        }
      };

      const controller: SseController = {
        send: (payload) => enqueue(sseData(payload)),
        sendEvent: (event, payload) => enqueue(sseEvent(event, payload)),
        interval: (ms, tick) => {
          const id = setInterval(() => {
            if (closed) return;
            tick();
          }, ms);
          timers.add(id);
        },
      };

      produce(controller);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
