import { createInterface } from "readline";
import { Readable } from "stream";

/**
 * Converts a Node.js Readable stream to an async iterator
 * Handles Dockerode's event-based streams and converts them to async iterables
 * Properly cleans up event listeners to prevent memory leaks
 *
 * @param stream - Node.js Readable stream (e.g., from Dockerode stats)
 * @returns AsyncGenerator that yields parsed JSON objects from the stream
 */
export async function* streamToAsyncIterator<T>(
  stream: NodeJS.ReadableStream
): AsyncGenerator<T, void, unknown> {
  const rl = createInterface({
    input: stream as Readable,
    terminal: false,
    crlfDelay: Infinity, // Handles both \n and \r\n
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        yield JSON.parse(trimmed) as T;
      } catch (parseError) {
        console.error('[streamToAsyncIterator] Failed to parse JSON line:', parseError);
        // Continue to next line
      }
    }
  } finally {
    // Cleanup the stream if the generator is exited early (e.g., via break)
    if (stream && 'destroy' in stream) {
      (stream as any).destroy();
    }
  }
}

/**
 * Merges multiple async iterables into a single async generator
 * Uses Promise.race to yield from whichever stream produces data first
 * Properly handles errors and cleanup for each iterator
 *
 * @param iterables - Array of async iterables to merge
 * @returns AsyncGenerator that yields values from all input iterables
 */
export async function* mergeAsyncIterables<T>(
  iterables: AsyncIterable<T>[]
): AsyncGenerator<T, void, unknown> {
  if (iterables.length === 0) {
    return;
  }

  const iterators = iterables.map(it => it[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>();
  const completedIterators = new Set<number>();

  // Start all iterators
  for (let i = 0; i < iterators.length; i++) {
    pending.set(
      i,
      iterators[i].next().then(result => ({ index: i, result }))
        .catch(error => ({ index: i, result: { done: true, value: undefined, error } as any }))
    );
  }

  try {
    // Yield values as they arrive from any stream
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());

      // Remove the completed promise
      pending.delete(index);

      // Handle error in result
      if ((result as any).error) {
        console.error(`Stream ${index} error:`, (result as any).error);
        completedIterators.add(index);
        continue;
      }

      if (!result.done) {
        yield result.value;

        // Schedule next iteration for this iterator if not completed
        if (!completedIterators.has(index)) {
          pending.set(
            index,
            iterators[index].next().then(result => ({ index, result }))
              .catch(error => ({ index, result: { done: true, value: undefined, error } as any }))
          );
        }
      } else {
        // Iterator completed, mark as done
        completedIterators.add(index);
      }
    }
  } finally {
    // Cleanup: call return() on all remaining iterators
    for (let i = 0; i < iterators.length; i++) {
      if (!completedIterators.has(i) && iterators[i].return) {
        try {
          await iterators[i].return!();
        } catch (err) {
          console.error(`Error closing iterator ${i}:`, err);
        }
      }
    }
  }
}
