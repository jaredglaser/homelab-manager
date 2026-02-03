import { useEffect, useState } from 'react';

interface UseServerStreamOptions<T> {
  streamFn: () => Promise<AsyncIterable<T>>;
  onData: (data: T) => void;
  retry?: {
    enabled: boolean;
    baseDelay?: number;
    maxDelay?: number;
  };
}

interface UseServerStreamResult {
  isStreaming: boolean;
  error: Error | null;
}

export function useServerStream<T>({
  streamFn,
  onData,
  retry,
}: UseServerStreamOptions<T>): UseServerStreamResult {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let aborted = false;

    async function startStream() {
      setIsStreaming(true);
      setError(null);

      if (retry?.enabled) {
        const baseDelay = retry.baseDelay ?? 1_000;
        const maxDelay = retry.maxDelay ?? 30_000;
        let retryCount = 0;

        while (!aborted) {
          try {
            for await (const data of await streamFn()) {
              if (aborted) break;
              retryCount = 0;
              setError(null);
              onData(data);
            }
          } catch (err) {
            if (!aborted) {
              setError(err as Error);
            }
          }

          if (aborted) break;

          const delay = Math.min(baseDelay * 2 ** retryCount, maxDelay);
          retryCount++;
          await new Promise((r) => setTimeout(r, delay));
          setError(null);
        }
      } else {
        try {
          for await (const data of await streamFn()) {
            if (aborted) break;
            onData(data);
          }
        } catch (err) {
          if (!aborted) {
            setError(err as Error);
          }
        }
      }

      if (!aborted) {
        setIsStreaming(false);
      }
    }

    startStream();

    return () => {
      aborted = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { isStreaming, error };
}
