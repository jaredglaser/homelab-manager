import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { detectZfsCapabilities } from '../lib/zfs-capabilities';

const originalSpawn = Bun.spawn;

type SpawnArgs = Parameters<typeof Bun.spawn>;

function createMockProc(
  stdout: string,
  exitCode: number
): { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> } {
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  };
}

describe('detectZfsCapabilities', () => {
  let spawnMock: ReturnType<typeof mock>;

  beforeEach(() => {
    spawnMock = mock();
    (Bun as any).spawn = spawnMock;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  test('returns unavailable when zpool binary not found', async () => {
    spawnMock.mockImplementation((_cmd: SpawnArgs[0]) => {
      return createMockProc('', 1);
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: false,
      tier: 0,
      permissions: [],
    });
  });

  test('returns tier 1 when zpool exists but no delegation permissions', async () => {
    spawnMock.mockImplementation((cmd: SpawnArgs[0]) => {
      const args = cmd as string[];
      if (args[0] === 'which') {
        return createMockProc('/usr/sbin/zpool', 0);
      }
      if (args[0] === 'zpool' && args[1] === 'version') {
        return createMockProc(
          'zfs-2.2.2-1\nzfs-kmod-2.2.2-1',
          0
        );
      }
      if (args[0] === 'zfs' && args[1] === 'allow') {
        return createMockProc('', 1);
      }
      return createMockProc('', 1);
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: true,
      version: '2.2.2',
      tier: 1,
      permissions: ['read'],
    });
  });

  test('returns tier 2 when delegation includes snapshot permissions', async () => {
    const allowOutput = [
      '---- Permissions on tank ----',
      'Local+Descendent permissions:',
      '        user agent snapshot,hold,send,rollback,destroy',
    ].join('\n');

    spawnMock.mockImplementation((cmd: SpawnArgs[0]) => {
      const args = cmd as string[];
      if (args[0] === 'which') {
        return createMockProc('/usr/sbin/zpool', 0);
      }
      if (args[0] === 'zpool' && args[1] === 'version') {
        return createMockProc('zfs-2.2.2-1\nzfs-kmod-2.2.2-1', 0);
      }
      if (args[0] === 'zfs' && args[1] === 'allow') {
        return createMockProc(allowOutput, 0);
      }
      return createMockProc('', 1);
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: true,
      version: '2.2.2',
      tier: 2,
      permissions: ['read', 'destroy', 'hold', 'rollback', 'send', 'snapshot'],
    });
  });

  test('handles zpool version command failure gracefully', async () => {
    spawnMock.mockImplementation((cmd: SpawnArgs[0]) => {
      const args = cmd as string[];
      if (args[0] === 'which') {
        return createMockProc('/usr/sbin/zpool', 0);
      }
      if (args[0] === 'zpool') {
        return createMockProc('', 1);
      }
      if (args[0] === 'zfs') {
        return createMockProc('', 1);
      }
      return createMockProc('', 1);
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: true,
      version: undefined,
      tier: 1,
      permissions: ['read'],
    });
  });

  test('falls back to zpool --version when zpool version fails', async () => {
    spawnMock.mockImplementation((cmd: SpawnArgs[0]) => {
      const args = cmd as string[];
      if (args[0] === 'which') {
        return createMockProc('/usr/sbin/zpool', 0);
      }
      if (args[0] === 'zpool' && args[1] === 'version') {
        return createMockProc('', 1);
      }
      if (args[0] === 'zpool' && args[1] === '--version') {
        return createMockProc('zfs-2.1.0-rc1\nzfs-kmod-2.1.0', 0);
      }
      if (args[0] === 'zfs') {
        return createMockProc('', 1);
      }
      return createMockProc('', 1);
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: true,
      version: '2.1.0-rc1',
      tier: 1,
      permissions: ['read'],
    });
  });

  test('returns tier 1 when only partial snapshot permissions exist', async () => {
    const allowOutput = [
      '---- Permissions on tank ----',
      'Local+Descendent permissions:',
      '        user agent snapshot,hold',
    ].join('\n');

    spawnMock.mockImplementation((cmd: SpawnArgs[0]) => {
      const args = cmd as string[];
      if (args[0] === 'which') {
        return createMockProc('/usr/sbin/zpool', 0);
      }
      if (args[0] === 'zpool' && args[1] === 'version') {
        return createMockProc('zfs-2.2.2-1', 0);
      }
      if (args[0] === 'zfs' && args[1] === 'allow') {
        return createMockProc(allowOutput, 0);
      }
      return createMockProc('', 1);
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: true,
      version: '2.2.2',
      tier: 1,
      permissions: ['read', 'hold', 'snapshot'],
    });
  });

  test('handles Bun.spawn throwing an error', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await detectZfsCapabilities();

    expect(result).toEqual({
      available: false,
      tier: 0,
      permissions: [],
    });
  });
});
