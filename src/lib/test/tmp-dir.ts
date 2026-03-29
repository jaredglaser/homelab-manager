import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DEV_SHM = '/dev/shm';

/**
 * Returns a writable base temp directory for tests.
 * Prefers /dev/shm (Linux in-memory tmpfs) for speed, falls back to project .tmp/.
 */
export function getTestTmpDir(): string {
  if (existsSync(DEV_SHM)) {
    const dir = join(DEV_SHM, 'homelab-manager-tests');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = join(process.cwd(), '.tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}
