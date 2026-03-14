import { describe, expect, test, mock } from 'bun:test';
import { handleStatsStream } from '../routes/stats';

describe('handleStatsStream', () => {
  test('returns SSE response with correct headers', () => {
    const mockDocker = { listContainers: mock(() => Promise.resolve([])) };
    const request = new Request('http://localhost/stats/stream');
    const response = handleStatsStream(mockDocker as any, request);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  test('returns 200 status', () => {
    const mockDocker = { listContainers: mock(() => Promise.resolve([])) };
    const request = new Request('http://localhost/stats/stream');
    const response = handleStatsStream(mockDocker as any, request);
    expect(response.status).toBe(200);
  });
});
