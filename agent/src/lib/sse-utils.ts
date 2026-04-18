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
    if (err instanceof TypeError && /closed/i.test(err.message)) {
      // Controller was closed between our check and enqueue. Mark closed so
      // subsequent sends short-circuit without another enqueue attempt.
      closed.value = true;
      return;
    }
    if (err instanceof TypeError) throw err;
    console.error('Unexpected error during SSE enqueue:', err);
  }
}
