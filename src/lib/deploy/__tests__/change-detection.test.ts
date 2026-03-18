// src/lib/deploy/__tests__/change-detection.test.ts

import { describe, it, expect } from 'bun:test';
import { computeHash, detectChanges } from '../change-detection';
import type { DeployRecord } from '@/lib/deploy/types';

describe('computeHash', () => {
  it('returns a consistent hex hash for the same input', () => {
    const hash1 = computeHash('hello world');
    const hash2 = computeHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different input', () => {
    const hash1 = computeHash('content a');
    const hash2 = computeHash('content b');
    expect(hash1).not.toBe(hash2);
  });

  it('returns a hex string', () => {
    const hash = computeHash('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('detectChanges', () => {
  const baseRecord: DeployRecord = {
    id: 1,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'abc123',
    composeHash: computeHash('compose-v1'),
    envHash: computeHash('env-v1'),
    status: 'succeeded',
    trigger: 'git_push',
    logs: null,
    createdAt: new Date(),
  };

  it('returns changed=true when no previous deploy exists (first deploy)', () => {
    const result = detectChanges('compose-v1', 'env-v1', null);
    expect(result.changed).toBe(true);
    expect(result.composeHash).toBeTruthy();
    expect(result.envHash).toBeTruthy();
  });

  it('returns changed=false when compose and env are identical', () => {
    const result = detectChanges('compose-v1', 'env-v1', baseRecord);
    expect(result.changed).toBe(false);
  });

  it('returns changed=true when compose changed', () => {
    const result = detectChanges('compose-v2', 'env-v1', baseRecord);
    expect(result.changed).toBe(true);
  });

  it('returns changed=true when env changed', () => {
    const result = detectChanges('compose-v1', 'env-v2', baseRecord);
    expect(result.changed).toBe(true);
  });

  it('returns changed=true when both changed', () => {
    const result = detectChanges('compose-v2', 'env-v2', baseRecord);
    expect(result.changed).toBe(true);
  });
});
