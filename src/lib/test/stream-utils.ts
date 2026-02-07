import { Readable } from 'stream';

/**
 * Converts objects into a stream of Newline-Delimited JSON (NDJSON)
 * Mimics how Dockerode and other APIs stream data.
 */
export function createMockJSONStream(objects: any[]): Readable {
  const ndjson = objects.map(obj => JSON.stringify(obj) + '\n');
  return Readable.from(ndjson);
}