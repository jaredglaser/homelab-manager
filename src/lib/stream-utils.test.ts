import { describe, it, expect, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { streamToAsyncIterator } from './stream-utils';
import { createMockJSONStream } from './test/stream-utils';

describe('streamToAsyncIterator', () => {
  it('should convert a Node.js stream to async iterator', async () => {
    const testData = [
      { id: '1', value: 'first' },
      { id: '2', value: 'second' },
      { id: '3', value: 'third' },
    ];

    // Use utility to ensure newlines are added correctly
    const stream = createMockJSONStream(testData);

    const results: typeof testData = [];
    for await (const item of streamToAsyncIterator<typeof testData[0]>(stream)) {
      results.push(item);
    }

    expect(results).toEqual(testData);
  });

  it('should handle stream errors', async () => {
    const stream = new Readable({
      read() {
        this.emit('error', new Error('Stream error'));
      },
    });

    const iterator = streamToAsyncIterator(stream);
    await expect(iterator.next()).rejects.toThrow('Stream error');
  });

  it('should handle empty streams', async () => {
    const stream = Readable.from([]);

    const results = [];
    for await (const item of streamToAsyncIterator(stream)) {
      results.push(item);
    }

    expect(results).toEqual([]);
  });

  it('should handle malformed JSON gracefully', async () => {
    // Manually constructing mixed stream to test malformed logic specifically
    const stream = Readable.from([
      JSON.stringify({ id: '1', value: 'valid' }) + '\n',
      'invalid json{{{\n',
      JSON.stringify({ id: '2', value: 'also valid' }) + '\n',
    ]);

    const results = [];
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    for await (const item of streamToAsyncIterator(stream)) {
      results.push(item);
    }

    expect(results).toEqual([
      { id: '1', value: 'valid' },
      { id: '2', value: 'also valid' },
    ]);
    
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('should clean up stream on completion', async () => {
    const stream = createMockJSONStream([{ test: 'data' }]);
    const destroySpy = spyOn(stream, 'destroy');

    for await (const _ of streamToAsyncIterator(stream)) {
      // Consume
    }

    expect(destroySpy).toHaveBeenCalled();
  });

  it('should handle backpressure with buffering', async () => {
    const inputData = Array.from({ length: 5 }, (_, i) => ({ id: i, value: `item-${i}` }));
    const sourceStream = createMockJSONStream(inputData);
    
    const asyncIterable = streamToAsyncIterator(sourceStream);
    const results: any[] = [];

    for await (const chunk of asyncIterable) {
      results.push(chunk); 
    }

    expect(results).toEqual(inputData);
  });

  it('should handle incomplete JSON split across chunks', async () => {
    const fullJson = { id: 'test-123', value: 'complete-data', nested: { key: 'value' } };
    const rawString = JSON.stringify(fullJson);
    const splitPoint = Math.floor(rawString.length / 2);

    // split string without a newline in the middle
    const chunk1 = rawString.substring(0, splitPoint);
    const chunk2 = rawString.substring(splitPoint) + '\n';

    const stream = Readable.from([chunk1, chunk2]);

    const results = [];
    for await (const item of streamToAsyncIterator(stream)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(fullJson);
  });

  it('should handle multiple JSON objects in a single chunk', async () => {
    const data = [{ id: '1' }, { id: '2' }, { id: '3' }];
    // Combine into one chunk separated by newlines
    const combinedChunk = data.map(d => JSON.stringify(d)).join('\n') + '\n';

    const stream = Readable.from([combinedChunk]);

    const results = [];
    for await (const item of streamToAsyncIterator(stream)) {
      results.push(item);
    }

    expect(results).toEqual(data);
  });

  it('should handle mixed complete and incomplete JSON across chunks', async () => {
    const json1 = JSON.stringify({ id: '1', complete: true });
    const json2 = JSON.stringify({ id: '2', complete: true });
    const json3 = JSON.stringify({ id: '3', large: 'data'.repeat(100) });
    const json4 = JSON.stringify({ id: '4', value: 'test' });

    const chunk1 = `${json1}\n${json2.substring(0, 20)}`;
    const chunk2 = `${json2.substring(20)}\n${json3}\n${json4.substring(0, 15)}`;
    const chunk3 = json4.substring(15) + '\n';

    const stream = Readable.from([chunk1, chunk2, chunk3]);

    const results = [];
    for await (const item of streamToAsyncIterator(stream)) {
      results.push(item);
    }

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ id: '1', complete: true });
    expect(results[1]).toEqual({ id: '2', complete: true });
    expect(results[2]).toEqual({ id: '3', large: 'data'.repeat(100) });
    expect(results[3]).toEqual({ id: '4', value: 'test' });
  });

  it('should handle empty lines between JSON objects', async () => {
    const data = [{ id: '1' }, { id: '2' }];
    const chunkWithEmptyLines = `${JSON.stringify(data[0])}\n\n${JSON.stringify(data[1])}\n\n`;

    const stream = Readable.from([chunkWithEmptyLines]);

    const results = [];
    for await (const item of streamToAsyncIterator(stream)) {
      results.push(item);
    }

    expect(results).toEqual(data);
  });

  it('should handle Docker stats format with nested objects', async () => {
    const dockerStats = {
      read: '2024-02-01T12:00:00Z',
      cpu_stats: { cpu_usage: { total_usage: 1000000 } },
      memory_stats: { usage: 1024000 },
    };

    // Use helper to ensure correct wrapping and newline termination
    const stream = createMockJSONStream([dockerStats]);

    const results = [];
    for await (const item of streamToAsyncIterator<typeof dockerStats>(stream)) {
      results.push(item);
    }

    expect(results[0]).toEqual(dockerStats);
  });
});
