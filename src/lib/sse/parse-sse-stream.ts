/**
 * Parses an upstream SSE byte stream into frames. The agent speaks SSE but the
 * multiplexing endpoint must tag each frame with its source container, so the
 * raw bytes cannot be piped through verbatim; this reconstructs the frames the
 * agent's `createSseStream` wrote (single `event:` field, `data:` payload,
 * `:` comment heartbeats).
 */

export interface SseFrame {
  /** Named event type, or null for a default `data:`-only message frame. */
  event: string | null;
  data: string;
}

export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      buffered += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let separator = buffered.indexOf('\n\n');
      while (separator !== -1) {
        const frame = parseFrame(buffered.slice(0, separator));
        buffered = buffered.slice(separator + 2);
        if (frame) onFrame(frame);
        separator = buffered.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (event === null && dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}
