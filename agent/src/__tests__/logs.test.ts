import { describe, expect, test, mock } from 'bun:test';
import { handleLogStream } from '../routes/logs';

describe('handleLogStream', () => {
  test('returns SSE response with correct headers', () => {
    const mockContainer = {
      logs: mock(() => Promise.resolve(Buffer.from(''))),
      inspect: mock(() => Promise.resolve({ Config: { Tty: false } })),
    };
    const mockDocker = {
      getContainer: mock(() => mockContainer),
    };
    const request = new Request('http://localhost/logs/abc123');
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.status).toBe(200);
  });
});
