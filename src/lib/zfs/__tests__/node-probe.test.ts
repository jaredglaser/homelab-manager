import { describe, expect, spyOn, test } from 'bun:test';
import * as influx from '@/lib/zfs/zpool-influxdb';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import { EMPTY_STATUS, FakeZfsTransport, ManualTimer, immediateTimer } from '@/lib/test/fake-zfs-ssh';
import { MAX_EXEC_OUTPUT_BYTES, ZfsSshError } from '../ssh-transport';
import { failureFromError, scanHostKey, verifyNode } from '../node-probe';

const target = { host: 'pve1.lan', port: 22, username: 'hlm', privateKey: 'key' };
const TANK = JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', vdevs: { tank: { name: 'tank', vdevs: {} } } } } });
const TANK_LINE = 'zpool_stats,name=tank,state=ONLINE,vdev=root alloc=1u,free=1u,size=2u,read_bytes=0u,read_errors=0u,read_ops=0u,write_bytes=0u,write_errors=0u,write_ops=0u,checksum_errors=0u,fragmentation=0u 1\n';

describe('node probe', () => {
  test('maps every transport failure to a node state', () => {
    expect(failureFromError(new ZfsSshError('unreachable', 'x'))).toBe('unreachable');
    expect(failureFromError(new ZfsSshError('host_key', 'x'))).toBe('host_key_changed');
    expect(failureFromError(new ZfsSshError('key_refused', 'x'))).toBe('key_refused');
    expect(failureFromError(new ZfsSshError('no_ed25519_key', 'x'))).toBe('no_ed25519_key');
    expect(failureFromError(new ZfsSshError('timeout', 'x'))).toBe('timeout');
    expect(failureFromError(new ZfsSshError('error', 'x'))).toBe('error');
    expect(failureFromError(new Error('anything else'))).toBe('error');
  });

  test('reports an unreachable node on the scan', async () => {
    const transport = new FakeZfsTransport();
    transport.connect = () => Promise.reject(new ZfsSshError('unreachable', 'ECONNREFUSED'));
    expect(await scanHostKey(transport, target)).toEqual({ ok: false, failure: 'unreachable' });
  });

  test('reads the pools and waits for zpool_influxdb to answer', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK, stderr: '' }, influx: () => TANK_LINE });
    expect(await verifyNode(transport, target, 'SHA256:node-key', immediateTimer)).toEqual({ ok: true, pools: ['tank'] });
  });

  test('reports zpool status output it cannot read as a failed read', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: 'no pools available', stderr: '' } });
    expect(await verifyNode(transport, target, 'SHA256:node-key', immediateTimer)).toEqual({ ok: false, failure: 'error', fingerprint: null });
  });

  test('reports zpool_influxdb exiting without a sample as a failed read', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK, stderr: '' }, influxExit: 1 });
    expect(await verifyNode(transport, target, 'SHA256:node-key', immediateTimer)).toEqual({ ok: false, failure: 'error', fingerprint: null });
  });

  test('refuses a node presenting another key than the pinned one, with the key it presented', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:other' });
    expect(await verifyNode(transport, target, 'SHA256:node-key', immediateTimer)).toEqual({ ok: false, failure: 'host_key_changed', fingerprint: 'SHA256:other' });
    expect(transport.sessions).toHaveLength(0);
  });

  test('times out a zpool_influxdb that never answers on the verify step', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK, stderr: '' }, influx: () => null });
    const timer = new ManualTimer();
    const result = verifyNode(transport, target, 'SHA256:node-key', timer.timer);
    await waitForCondition(() => timer.count === 1);
    timer.fireAll();
    expect(await result).toEqual({ ok: false, failure: 'timeout', fingerprint: null });
    expect(transport.sessions[0].closed).toBe(true);
  });

  test('takes an open channel on a node with no pools as zpool_influxdb being there', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: EMPTY_STATUS, stderr: '' }, influx: () => null });
    expect(await verifyNode(transport, target, 'SHA256:node-key', immediateTimer)).toEqual({ ok: true, pools: [] });
  });

  test('stops reading output past the cap without a sample in it', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK, stderr: '' }, influx: () => 'x'.repeat(MAX_EXEC_OUTPUT_BYTES + 1) });
    const timer = new ManualTimer();
    expect(await verifyNode(transport, target, 'SHA256:node-key', timer.timer)).toEqual({ ok: false, failure: 'error', fingerprint: null });
  });

  test('scans a large answer once, not again for every chunk', async () => {
    const chunks = 2000;
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK, stderr: '' }, influx: () => null });
    const timer = new ManualTimer();
    const parse = spyOn(influx, 'parseInfluxLine');
    try {
      const result = verifyNode(transport, target, 'SHA256:node-key', timer.timer);
      await waitForCondition(() => transport.sessions[0]?.streams.length === 1);
      const stream = transport.sessions[0].streams[0];
      for (let i = 0; i < chunks; i++) stream.emit(`zpool_scan_stats,name=tank x=${i}u 1\n`);
      stream.emit(TANK_LINE);
      expect(await result).toEqual({ ok: true, pools: ['tank'] });
      expect(parse.mock.calls.length).toBe(chunks + 1);
    } finally {
      parse.mockRestore();
    }
  });
});
