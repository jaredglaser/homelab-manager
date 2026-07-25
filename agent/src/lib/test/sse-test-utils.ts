/** Read chunks from an SSE response until the predicate is satisfied or the timeout elapses. */
export async function readUntil(
  response: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`readUntil timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (predicate(text)) break;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
  } finally {
    reader.cancel();
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
