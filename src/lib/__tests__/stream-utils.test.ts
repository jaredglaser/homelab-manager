import { describe, it, expect, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { streamToAsyncIterator, mergeAsyncIterables } from '../stream-utils';
import { createMockJSONStream } from '../test/stream-utils';

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

describe('mergeAsyncIterables', () => {
  // Helper to create timed async iterables for testing race conditions
  async function* createTimedIterable<T>(items: T[], delayMs: number) {
    for (const item of items) {
      await new Promise(r => setTimeout(r, delayMs));
      yield item;
    }
  }

  // Helper to create an iterable that throws an error
  async function* createErrorIterable<T>(items: T[], errorAfter: number, errorMessage: string) {
    for (let i = 0; i < items.length; i++) {
      if (i === errorAfter) {
        throw new Error(errorMessage);
      }
      yield items[i];
    }
  }

  it('should merge multiple async iterables and yield values as they arrive', async () => {
    const iterable1 = (async function* () {
      yield { id: 1, source: 'A' };
      yield { id: 2, source: 'A' };
    })();

    const iterable2 = (async function* () {
      yield { id: 3, source: 'B' };
      yield { id: 4, source: 'B' };
    })();

    const iterable3 = (async function* () {
      yield { id: 5, source: 'C' };
    })();

    const results = [];
    for await (const item of mergeAsyncIterables([iterable1, iterable2, iterable3])) {
      results.push(item);
    }

    expect(results).toHaveLength(5);

    // Verify all items are present (order may vary due to Promise.race)
    const sourceACounts = results.filter(r => r.source === 'A').length;
    const sourceBCounts = results.filter(r => r.source === 'B').length;
    const sourceCCounts = results.filter(r => r.source === 'C').length;

    expect(sourceACounts).toBe(2);
    expect(sourceBCounts).toBe(2);
    expect(sourceCCounts).toBe(1);
  });

  it('should handle empty array of iterables', async () => {
    const results = [];
    for await (const item of mergeAsyncIterables([])) {
      results.push(item);
    }

    expect(results).toEqual([]);
  });

  it('should handle single iterable', async () => {
    const iterable = (async function* () {
      yield 1;
      yield 2;
      yield 3;
    })();

    const results = [];
    for await (const item of mergeAsyncIterables([iterable])) {
      results.push(item);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it('should handle errors from one iterator and continue with others', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const iterable1 = createErrorIterable([1, 2, 3], 1, 'Error in iterable1');
    const iterable2 = (async function* () {
      yield 10;
      yield 20;
      yield 30;
    })();

    const results = [];
    for await (const item of mergeAsyncIterables([iterable1, iterable2])) {
      results.push(item);
    }

    // Should get the first value from iterable1 before error, and all from iterable2
    expect(results).toContain(1);
    expect(results).toContain(10);
    expect(results).toContain(20);
    expect(results).toContain(30);

    // Error should be logged
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorCalls = consoleErrorSpy.mock.calls.filter(call =>
      call[0]?.toString().includes('Stream') && call[0]?.toString().includes('error')
    );
    expect(errorCalls.length).toBeGreaterThan(0);

    consoleErrorSpy.mockRestore();
  });

  it('should handle errors from multiple iterators', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const iterable1 = createErrorIterable([1], 0, 'Error 1');
    const iterable2 = createErrorIterable([2], 0, 'Error 2');
    const iterable3 = (async function* () {
      yield 100;
    })();

    const results = [];
    for await (const item of mergeAsyncIterables([iterable1, iterable2, iterable3])) {
      results.push(item);
    }

    // Should get the successful value
    expect(results).toContain(100);

    // Both errors should be logged
    expect(consoleErrorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    consoleErrorSpy.mockRestore();
  });

  it('should call return() on all iterators when generator exits early', async () => {
    const returnSpy1 = { called: false };
    const returnSpy2 = { called: false };
    const returnSpy3 = { called: false };

    const createIterableWithReturn = (items: number[], spy: { called: boolean }) => {
      const gen = (async function* () {
        for (const item of items) {
          yield item;
        }
      })();

      const originalReturn = gen.return;
      gen.return = async function (value?: any) {
        spy.called = true;
        return originalReturn ? originalReturn.call(gen, value) : { done: true, value };
      };

      return gen;
    };

    const iterable1 = createIterableWithReturn([1, 2, 3, 4, 5], returnSpy1);
    const iterable2 = createIterableWithReturn([10, 20, 30, 40, 50], returnSpy2);
    const iterable3 = createIterableWithReturn([100, 200, 300, 400, 500], returnSpy3);

    let count = 0;
    for await (const item of mergeAsyncIterables([iterable1, iterable2, iterable3])) {
      count++;
      if (count >= 3) break; // Exit early
    }

    expect(count).toBe(3);

    // At least some iterators should have return() called
    // (The exact number depends on which iterators had yielded vs pending when we broke)
    const returnsCalled = [returnSpy1.called, returnSpy2.called, returnSpy3.called].filter(Boolean).length;
    expect(returnsCalled).toBeGreaterThan(0);
  });

  it('should cleanup completed iterators', async () => {
    const shortIterable = (async function* () {
      yield 1;
    })();

    const longIterable = (async function* () {
      await new Promise(r => setTimeout(r, 10));
      yield 2;
      await new Promise(r => setTimeout(r, 10));
      yield 3;
    })();

    const results = [];
    for await (const item of mergeAsyncIterables([shortIterable, longIterable])) {
      results.push(item);
    }

    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(3);
    expect(results).toHaveLength(3);
  });

  it('should handle iterators completing in different orders', async () => {
    const fastIterable = createTimedIterable([1, 2], 5);
    const mediumIterable = createTimedIterable([10, 20], 15);
    const slowIterable = createTimedIterable([100], 25);

    const results = [];
    for await (const item of mergeAsyncIterables([fastIterable, mediumIterable, slowIterable])) {
      results.push(item);
    }

    expect(results).toHaveLength(5);
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(10);
    expect(results).toContain(20);
    expect(results).toContain(100);
  });

  it('should use Promise.race correctly to yield from fastest source', async () => {
    const fastIterable = createTimedIterable(['fast-1', 'fast-2'], 1);
    const slowIterable = createTimedIterable(['slow-1', 'slow-2'], 50);

    const results = [];
    for await (const item of mergeAsyncIterables([fastIterable, slowIterable])) {
      results.push(item);
    }

    // Fast items should be collected (though order within fast/slow groups may vary)
    expect(results).toContain('fast-1');
    expect(results).toContain('fast-2');
    expect(results).toContain('slow-1');
    expect(results).toContain('slow-2');
  });

  it('should continue iterating after one source completes', async () => {
    const quickIterable = (async function* () {
      yield 'quick';
    })();

    const continuesIterable = (async function* () {
      await new Promise(r => setTimeout(r, 10));
      yield 'continues-1';
      await new Promise(r => setTimeout(r, 10));
      yield 'continues-2';
    })();

    const results = [];
    for await (const item of mergeAsyncIterables([quickIterable, continuesIterable])) {
      results.push(item);
    }

    expect(results).toContain('quick');
    expect(results).toContain('continues-1');
    expect(results).toContain('continues-2');
    expect(results).toHaveLength(3);
  });

  it('should work with streamToAsyncIterator outputs', async () => {
    const stream1 = createMockJSONStream([{ id: 1, type: 'stream1' }]);
    const stream2 = createMockJSONStream([{ id: 2, type: 'stream2' }]);
    const stream3 = createMockJSONStream([{ id: 3, type: 'stream3' }]);

    const iterable1 = streamToAsyncIterator<{ id: number; type: string }>(stream1);
    const iterable2 = streamToAsyncIterator<{ id: number; type: string }>(stream2);
    const iterable3 = streamToAsyncIterator<{ id: number; type: string }>(stream3);

    const results = [];
    for await (const item of mergeAsyncIterables([iterable1, iterable2, iterable3])) {
      results.push(item);
    }

    expect(results).toHaveLength(3);
    expect(results.find(r => r.type === 'stream1')).toBeDefined();
    expect(results.find(r => r.type === 'stream2')).toBeDefined();
    expect(results.find(r => r.type === 'stream3')).toBeDefined();
  });

  it('should handle iterator with no return method gracefully', async () => {
    const iterableWithoutReturn = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            if (count < 2) {
              return { done: false, value: count++ };
            }
            return { done: true, value: undefined };
          },
          // No return method
        };
      },
    };

    const results = [];
    for await (const value of mergeAsyncIterables([iterableWithoutReturn])) {
      results.push(value);
    }

    expect(results).toEqual([0, 1]);
  });

  it('should handle cleanup errors gracefully', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const iterableWithErrorOnReturn = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: 1 };
          },
          async return() {
            throw new Error('Cleanup error');
          },
        };
      },
    };

    const normalIterable = (async function* () {
      yield 2;
    })();

    let count = 0;
    for await (const _ of mergeAsyncIterables([iterableWithErrorOnReturn, normalIterable])) {
      count++;
      if (count >= 1) break; // Force cleanup
    }

    // Error during cleanup should be logged but not thrown
    await new Promise(r => setTimeout(r, 10)); // Give time for cleanup

    consoleErrorSpy.mockRestore();
  });
});
