import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getTestTmpDir } from '../tmp-dir';

describe('getTestTmpDir', () => {
  let existsSyncSpy: ReturnType<typeof spyOn> | undefined;
  let mkdirSyncSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    existsSyncSpy?.mockRestore();
    mkdirSyncSpy?.mockRestore();
  });

  it('returns /dev/shm path when /dev/shm exists', () => {
    const result = getTestTmpDir();
    // On Linux CI and dev machines, /dev/shm exists
    expect(result).toBe('/dev/shm/homelab-manager-tests');
  });

  it('returns .tmp fallback when /dev/shm does not exist', () => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

    const result = getTestTmpDir();
    expect(result).toBe(join(process.cwd(), '.tmp'));
  });
});
