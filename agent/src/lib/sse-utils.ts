/** Enqueue an SSE data event, silently swallowing enqueue-after-close TypeError. */
export function sendSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  closed: { value: boolean },
  data: string,
): void {
  if (closed.value) return;
  try {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  } catch (err) {
    if (!(err instanceof TypeError)) console.error('Unexpected error during SSE enqueue:', err);
  }
}
