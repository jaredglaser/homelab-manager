import { describe, it, expect } from 'bun:test';
import {
  startAnsibleRunSchema,
  cancelAnsibleRunSchema,
  listAnsibleRunsSchema,
} from '@/data/ansible/schemas';

describe('startAnsibleRunSchema', () => {
  it('defaults the playbook and check mode', () => {
    expect(startAnsibleRunSchema.parse({ hosts: ['host-a'] })).toEqual({
      playbook: 'host_baseline.yml',
      hosts: ['host-a'],
      checkMode: false,
    });
  });

  it('rejects a playbook that is a path rather than a bare filename', () => {
    for (const playbook of ['../../etc/passwd', '/abs/play.yml', 'sub/dir.yml', 'play.txt', 'play']) {
      expect(startAnsibleRunSchema.safeParse({ playbook, hosts: ['host-a'] }).success).toBe(false);
    }
    expect(startAnsibleRunSchema.safeParse({ playbook: 'host_baseline.yaml', hosts: ['h'] }).success).toBe(true);
  });

  it('requires at least one non-empty host', () => {
    expect(startAnsibleRunSchema.safeParse({ hosts: [] }).success).toBe(false);
    expect(startAnsibleRunSchema.safeParse({ hosts: [''] }).success).toBe(false);
  });
});

describe('cancelAnsibleRunSchema', () => {
  it('accepts only the character class the sidecar route matches', () => {
    expect(cancelAnsibleRunSchema.safeParse({ runId: 'a-b_C9' }).success).toBe(true);
    expect(cancelAnsibleRunSchema.safeParse({ runId: '../other' }).success).toBe(false);
    expect(cancelAnsibleRunSchema.safeParse({ runId: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('listAnsibleRunsSchema', () => {
  it('defaults and bounds the limit', () => {
    expect(listAnsibleRunsSchema.parse({})).toEqual({ limit: 20 });
    expect(listAnsibleRunsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listAnsibleRunsSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
