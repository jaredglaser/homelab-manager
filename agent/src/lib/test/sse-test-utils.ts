/** Read chunks from an SSE response until the predicate is satisfied or the timeout elapses. */
export async function readUntil(
  response: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  // One deadline for the whole read, not one per chunk: a per-chunk timer is reset
  // by every heartbeat frame, so a predicate that never matches would never fire it.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`readUntil timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) break;
    }
  } finally {
    clearTimeout(timeoutId);
    try {
      await reader.cancel();
    } catch {
      // cancel() rejects when the stream already errored, which several tests induce
    }
  }
  return text;
}

/** Parse the `data:` frames out of SSE text, ignoring the seam's flush and heartbeat comments. */
export function parseDataFrames(text: string): any[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}
