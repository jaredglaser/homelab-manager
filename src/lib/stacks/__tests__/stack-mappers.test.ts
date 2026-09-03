import { describe, test, expect } from 'bun:test';
import { computeSyncStatus } from '@/lib/stacks/stack-mappers';
import type { DeployRecord } from '@/lib/deploy/types';

const baseRecord: DeployRecord = {
  id: 1,
  stack: 'plex',
  host: 'homeserver',
  commitSha: 'abc123',
  composeHash: 'hash1',
  envHash: 'hash2',
  status: 'succeeded',
  trigger: 'git_push',
  action: 'deploy',
  forceRecreate: false,
  logs: null,
  createdAt: new Date('2026-01-01'),
  startedAt: null,
  postSuccess: null,
};

describe('computeSyncStatus', () => {
  test('returns unknown when no deploy history', () => {
    expect(computeSyncStatus(null, 'abc123')).toBe('unknown');
  });

  test('returns unknown when no deploy history and no HEAD SHA', () => {
    expect(computeSyncStatus(null, null)).toBe('unknown');
  });

  test('returns failed when latest deploy status is failed', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'failed' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('failed');
  });

  test('returns failed when latest deploy is failed regardless of SHA match', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'failed', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('failed');
  });

  test('returns in_sync when latest succeeded deploy SHA matches HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'succeeded', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('in_sync');
  });

  test('returns pending when latest succeeded deploy SHA differs from HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'succeeded', commitSha: 'old-sha' };
    expect(computeSyncStatus(deploy, 'new-sha')).toBe('pending');
  });

  test('returns in_sync when latest no_change deploy SHA matches HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'no_change', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('in_sync');
  });

  test('returns pending when latest no_change deploy SHA differs from HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'no_change', commitSha: 'old-sha' };
    expect(computeSyncStatus(deploy, 'new-sha')).toBe('pending');
  });

  test('returns pending for pending status (deploy not yet complete)', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'pending' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('pending');
  });

  test('returns in_progress for in_progress status (deploy not yet complete)', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'in_progress' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('in_progress');
  });

  test('returns pending when succeeded SHA matches but HEAD is null', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'succeeded', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, null)).toBe('pending');
  });
});
