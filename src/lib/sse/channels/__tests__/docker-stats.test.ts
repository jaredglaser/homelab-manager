import { describe, it, expect } from 'bun:test';
import { dockerStatsChannel } from '../docker-stats';

const wireRow = {
  time: Date.parse('2026-04-16T10:00:00.000Z'),
  host: 'server1',
  container_id: 'abc123',
  container_name: 'plex',
  image: 'plexinc/pms-docker:latest',
  cpu_percent: 12.5,
  memory_usage: 1024,
  memory_limit: 2048,
  memory_percent: 50,
  network_rx_bytes_per_sec: 100,
  network_tx_bytes_per_sec: 200,
  block_io_read_bytes_per_sec: 300,
  block_io_write_bytes_per_sec: 400,
};

describe('dockerStatsChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(dockerStatsChannel.url).toBe('/api/docker-stats');
    expect(dockerStatsChannel.errorEvent).toBe('stats_error');
  });

  it('validates an array of well-formed rows', () => {
    const result = dockerStatsChannel.schema.safeParse([wireRow]);
    expect(result.success).toBe(true);
  });

  it('rejects a string time (repository read path now normalizes to epoch ms)', () => {
    const result = dockerStatsChannel.schema.safeParse([{ ...wireRow, time: '2026-04-16T10:00:00.000Z' }]);
    expect(result.success).toBe(false);
  });

  it('rejects a row missing required fields', () => {
    const result = dockerStatsChannel.schema.safeParse([{ host: 'server1' }]);
    expect(result.success).toBe(false);
  });

  it('has no revive step; the schema shape matches DockerStatsRow directly', () => {
    expect(dockerStatsChannel.revive).toBeUndefined();
  });
});
