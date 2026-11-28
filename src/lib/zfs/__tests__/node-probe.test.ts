import { describe, expect, test } from 'bun:test';
import { FakeZfsTransport } from '@/lib/test/fake-zfs-ssh';
import { ZfsSshError } from '../ssh-transport';
import { failureFromError, scanHostKey, verifyNode } from '../node-probe';

const target = { host: 'pve1.lan', port: 22, username: 'hlm', privateKey: 'key' };
const TANK = JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', vdevs: { tank: { name: 'tank', vdevs: {} } } } } });
const TANK_LINE = 'zpool_stats,name=tank,state=ONLINE,vdev=root alloc=1u,free=1u,size=2u,read_bytes=0u,read_errors=0u,read_ops=0u,write_bytes=0u,write_errors=0u,write_ops=0u,checksum_errors=0u,fragmentation=0u 1\n';

describe('node probe', () => {
  test('maps every transport failure to a node state', () => {
    expect(failureFromError(new ZfsSshError('unreachable', 'x'))).toBe('unreachable');
    expect(failureFromError(new ZfsSshError('host_key', 'x'))).toBe('host_key_changed');
    expect(failureFromError(new ZfsSshError('key_refused', 'x'))).toBe('key_refused');
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
    expect(await verifyNode(transport, target, 'SHA256:node-key', 5)).toEqual({ ok: true, pools: ['tank'] });
  });

  test('reports zpool status output it cannot read as a failed read', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: 'no pools available', stderr: '' } });
    expect(await verifyNode(transport, target, 'SHA256:node-key', 5)).toEqual({ ok: false, failure: 'error', fingerprint: null });
  });

  test('reports zpool_influxdb exiting without a sample as a failed read', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK, stderr: '' }, influxExit: 1 });
    expect(await verifyNode(transport, target, 'SHA256:node-key', 5)).toEqual({ ok: false, failure: 'error', fingerprint: null });
  });

  test('refuses a node presenting another key than the pinned one, with the key it presented', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:other' });
    expect(await verifyNode(transport, target, 'SHA256:node-key', 5)).toEqual({ ok: false, failure: 'host_key_changed', fingerprint: 'SHA256:other' });
    expect(transport.sessions).toHaveLength(0);
  });
});
