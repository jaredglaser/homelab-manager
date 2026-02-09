import { describe, it, expect } from 'bun:test';
import { Readable } from 'stream';
import { createMockJSONStream, collectStreamOutput } from '../stream-utils';

describe('stream-utils', () => {
  describe('createMockJSONStream', () => {
    it('should create a readable stream from objects', async () => {
      const objects = [{ id: 1 }, { id: 2 }];
      const stream = createMockJSONStream(objects);

      expect(stream).toBeInstanceOf(Readable);
    });

    it('should output NDJSON format', async () => {
      const objects = [{ name: 'test' }, { value: 42 }];
      const stream = createMockJSONStream(objects);

      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk.toString());
      }

      expect(chunks).toEqual([
        '{"name":"test"}\n',
        '{"value":42}\n',
      ]);
    });

    it('should handle empty array', async () => {
      const stream = createMockJSONStream([]);

      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk.toString());
      }

      expect(chunks).toEqual([]);
    });

    it('should handle complex nested objects', async () => {
      const objects = [{ nested: { deep: { value: 'test' } } }];
      const stream = createMockJSONStream(objects);

      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk.toString());
      }

      expect(chunks[0]).toBe('{"nested":{"deep":{"value":"test"}}}\n');
    });
  });

  describe('collectStreamOutput', () => {
    it('should collect stream output into array', async () => {
      const stream = createMockJSONStream([{ a: 1 }, { b: 2 }]);
      const output = await collectStreamOutput(stream);

      expect(output).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('should handle stream with empty lines', async () => {
      const stream = Readable.from(['line1\n\nline2\n']);
      const output = await collectStreamOutput(stream);

      expect(output).toEqual(['line1', 'line2']);
    });

    it('should handle stream with whitespace-only lines', async () => {
      const stream = Readable.from(['line1\n   \nline2\n']);
      const output = await collectStreamOutput(stream);

      expect(output).toEqual(['line1', 'line2']);
    });

    it('should handle empty stream', async () => {
      const stream = Readable.from([]);
      const output = await collectStreamOutput(stream);

      expect(output).toEqual([]);
    });

    it('should handle multiple chunks', async () => {
      const stream = Readable.from(['chunk1\n', 'chunk2\nchunk3\n']);
      const output = await collectStreamOutput(stream);

      expect(output).toEqual(['chunk1', 'chunk2', 'chunk3']);
    });
  });
});