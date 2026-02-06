import { describe, it, expect } from 'bun:test';
import { transformDockerStats, type EntityMetadata } from '../docker-transformer';
import type { LatestStatRow } from '@/lib/database/repositories/stats-repository';

describe('transformDockerStats', () => {
  const now = new Date();

  describe('without metadata', () => {
    it('uses short container ID as name fallback', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'abc123def456789xyz', value: 50.5 },
      ];

      const result = transformDockerStats(rows);
      const stats = result.get('abc123def456789xyz');

      expect(stats).toBeDefined();
      expect(stats!.id).toBe('abc123def456789xyz');
      expect(stats!.name).toBe('abc123def456'); // First 12 chars
      expect(stats!.rates.cpuPercent).toBe(50.5);
    });

    it('groups multiple stat types for same container', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'container1', value: 25.0 },
        { timestamp: now, type: 'memory_percent', entity: 'container1', value: 50.0 },
        { timestamp: now, type: 'memory_usage', entity: 'container1', value: 512 * 1024 * 1024 },
        { timestamp: now, type: 'memory_limit', entity: 'container1', value: 1024 * 1024 * 1024 },
      ];

      const result = transformDockerStats(rows);
      expect(result.size).toBe(1);

      const stats = result.get('container1');
      expect(stats!.rates.cpuPercent).toBe(25.0);
      expect(stats!.rates.memoryPercent).toBe(50.0);
      expect(stats!.memory_stats.usage).toBe(512 * 1024 * 1024);
      expect(stats!.memory_stats.limit).toBe(1024 * 1024 * 1024);
    });

    it('handles multiple containers', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'container1', value: 10.0 },
        { timestamp: now, type: 'cpu_percent', entity: 'container2', value: 20.0 },
      ];

      const result = transformDockerStats(rows);
      expect(result.size).toBe(2);
      expect(result.get('container1')!.rates.cpuPercent).toBe(10.0);
      expect(result.get('container2')!.rates.cpuPercent).toBe(20.0);
    });
  });

  describe('with metadata', () => {
    it('uses name from metadata', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'abc123def456', value: 75.0 },
      ];

      const metadata: EntityMetadata = new Map([
        ['abc123def456', new Map([['name', 'nginx-proxy']])],
      ]);

      const result = transformDockerStats(rows, metadata);
      const stats = result.get('abc123def456');

      expect(stats!.name).toBe('nginx-proxy');
    });

    it('falls back to short ID when entity not in metadata', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'unknown123456789', value: 30.0 },
      ];

      const metadata: EntityMetadata = new Map([
        ['different-entity', new Map([['name', 'other-container']])],
      ]);

      const result = transformDockerStats(rows, metadata);
      const stats = result.get('unknown123456789');

      expect(stats!.name).toBe('unknown12345'); // Short ID fallback
    });

    it('falls back to short ID when name key not in metadata', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'container123', value: 40.0 },
      ];

      const metadata: EntityMetadata = new Map([
        ['container123', new Map([['image', 'nginx:latest']])], // Has metadata but no 'name' key
      ]);

      const result = transformDockerStats(rows, metadata);
      const stats = result.get('container123');

      expect(stats!.name).toBe('container123'); // Short ID (already 12 chars)
    });

    it('handles multiple containers with different metadata', () => {
      const rows: LatestStatRow[] = [
        { timestamp: now, type: 'cpu_percent', entity: 'container-a', value: 10.0 },
        { timestamp: now, type: 'cpu_percent', entity: 'container-b', value: 20.0 },
        { timestamp: now, type: 'cpu_percent', entity: 'container-c', value: 30.0 },
      ];

      const metadata: EntityMetadata = new Map([
        ['container-a', new Map([['name', 'web-server']])],
        ['container-b', new Map([['name', 'database']])],
        // container-c has no metadata
      ]);

      const result = transformDockerStats(rows, metadata);

      expect(result.get('container-a')!.name).toBe('web-server');
      expect(result.get('container-b')!.name).toBe('database');
      expect(result.get('container-c')!.name).toBe('container-c'); // Fallback
    });
  });

  describe('timestamp handling', () => {
    it('uses most recent timestamp', () => {
      const older = new Date('2024-01-01T00:00:00Z');
      const newer = new Date('2024-01-01T00:00:05Z');

      const rows: LatestStatRow[] = [
        { timestamp: older, type: 'cpu_percent', entity: 'container1', value: 10.0 },
        { timestamp: newer, type: 'memory_percent', entity: 'container1', value: 20.0 },
      ];

      const result = transformDockerStats(rows);
      expect(result.get('container1')!.timestamp).toEqual(newer);
    });
  });

  describe('empty input', () => {
    it('returns empty map for empty rows', () => {
      const result = transformDockerStats([]);
      expect(result.size).toBe(0);
    });

    it('returns empty map for empty rows with metadata', () => {
      const metadata: EntityMetadata = new Map([
        ['unused', new Map([['name', 'unused']])],
      ]);
      const result = transformDockerStats([], metadata);
      expect(result.size).toBe(0);
    });
  });
});
