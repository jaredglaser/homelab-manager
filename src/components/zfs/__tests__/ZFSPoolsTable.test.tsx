import { describe, expect, it } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { setupUser } from '@/lib/test/user-event';
import ZFSPoolsTable from '../ZFSPoolsTable';
import type { ZFSStatsRow } from '@/types/zfs';

function poolRow(host: string, pool: string, entity = pool, entityType: ZFSStatsRow['entity_type'] = 'pool', indent = 0): ZFSStatsRow {
  return {
    time: 1000,
    host,
    pool,
    entity,
    entity_type: entityType,
    indent,
    capacity_alloc: 100,
    capacity_free: 900,
    read_ops_per_sec: 1,
    write_ops_per_sec: 1,
    read_bytes_per_sec: 1,
    write_bytes_per_sec: 1,
    utilization_percent: 10,
  };
}

describe('ZFSPoolsTable node notices', () => {
  it('shows a node notice above its last data, and gives a node with no data a row of its own', () => {
    const rows = [poolRow('pve1', 'rpool'), poolRow('pve2', 'rpool')];
    const notices = new Map([
      ['pve1', "Can't reach pve1 over SSH on port 22. Showing the last data, from 10:42."],
      ['pve3', 'pve3 is missing zpool_influxdb, which comes with ZFS. Update the zfsutils-linux package on the node.'],
    ]);
    render(
      <ZFSPoolsTable
        latestByEntity={new Map(rows.map((row) => [`${row.host}/${row.entity}`, row]))}
        hasData
        isConnected
        error={null}
        isStale={false}
        nodeNotices={notices}
      />,
    );

    expect(screen.getByTestId('zfs-node-notice-pve1').textContent).toBe(notices.get('pve1')!);
    expect(screen.getByTestId('zfs-node-notice-pve3').textContent).toBe(notices.get('pve3')!);
    expect(screen.queryByTestId('zfs-node-notice-pve2')).toBeNull();
    expect(screen.getByText('pve3')).toBeDefined();
  });

  it('opens a pool on a node with a notice to show its vdev and disks', async () => {
    const rows = [
      poolRow('pve1', 'tank'),
      poolRow('pve1', 'tank', 'tank/mirror-0', 'vdev', 2),
      poolRow('pve1', 'tank', 'tank/mirror-0/sda', 'disk', 4),
      poolRow('pve1', 'tank', 'tank/mirror-0/sdb', 'disk', 4),
      poolRow('pve1', 'tank', 'tank/mirror-1', 'vdev', 2),
      poolRow('pve1', 'tank', 'tank/mirror-1/sdc', 'disk', 4),
      poolRow('pve1', 'tank', 'tank/mirror-1/sdd', 'disk', 4),
    ];
    render(
      <ZFSPoolsTable
        latestByEntity={new Map(rows.map((row) => [`${row.host}/${row.entity}`, row]))}
        hasData
        isConnected
        error={null}
        isStale={false}
        nodeNotices={new Map([['pve1', 'pve1 notice']])}
      />,
    );
    const user = setupUser();
    expect(screen.getByTestId('zfs-node-notice-pve1').textContent).toBe('pve1 notice');
    await user.click(screen.getByText('tank'));
    await user.click(await screen.findByText('mirror-0'));
    expect(await screen.findByText('sda')).toBeDefined();
  });

  it('shows the stream error before any data, and a spinner while it connects', () => {
    const { unmount } = render(
      <ZFSPoolsTable latestByEntity={new Map()} hasData={false} isConnected={false} error={new Error('socket closed')} isStale={false} />,
    );
    expect(screen.getByText('Error connecting to ZFS stats: socket closed')).toBeDefined();
    unmount();
    const { container } = render(
      <ZFSPoolsTable latestByEntity={new Map()} hasData={false} isConnected={false} error={null} isStale={false} />,
    );
    expect(container.querySelector('[role="status"], svg')).not.toBeNull();
  });
});
