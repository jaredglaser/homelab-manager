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

/** Parse the named `event:` frames out of SSE text, ignoring the seam's flush and heartbeat comments. */
export function parseEventFrames(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown> };
    });
}

/** Rejects when `promise` has not settled in `ms`, so a run that never finishes or a stream that never closes fails the test instead of hanging it. */
export async function bounded<T>(promise: Promise<T>, what = 'promise', ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
