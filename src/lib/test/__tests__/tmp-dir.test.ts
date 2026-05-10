import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';

describe('getTestTmpDir', () => {
  let existsSyncSpy: ReturnType<typeof spyOn> | undefined;
  let mkdirSyncSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    existsSyncSpy?.mockRestore();
    mkdirSyncSpy?.mockRestore();
  });

  it('returns /dev/shm path when /dev/shm exists', () => {
    // /dev/shm is Linux-only. Stub existsSync so the assertion runs identically on macOS.
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

    const result = getTestTmpDir();
    expect(result).toBe('/dev/shm/homelab-manager-tests');
  });

  it('returns .tmp fallback when /dev/shm does not exist', () => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

    const result = getTestTmpDir();
    expect(result).toBe(join(process.cwd(), '.tmp'));
  });
});
