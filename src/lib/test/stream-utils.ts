import { Readable, PassThrough } from 'stream';

/**
 * Converts objects into a stream of Newline-Delimited JSON (NDJSON)
 * Mimics how Dockerode and other APIs stream data.
 */
export function createMockJSONStream(objects: any[]): Readable {
  const ndjson = objects.map(obj => JSON.stringify(obj) + '\n');
  return Readable.from(ndjson);
}

/**
 * Consumes a stream and captures the output into an array of strings.
 * Useful for asserting the raw output of a stream transformation.
 */
export async function collectStreamOutput(stream: PassThrough | Readable): Promise<string[]> {
  const results: string[] = [];
  for await (const chunk of stream) {
    const lines = chunk.toString().split('\n').filter((l: string) => l.trim() !== '');
    results.push(...lines);
  }
  return results;
}