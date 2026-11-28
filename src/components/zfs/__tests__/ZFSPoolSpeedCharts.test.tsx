import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { ZFSEntityType, ZFSStatsRow } from '@/types/zfs';

mock.module('@/components/zfs/ZFSPoolSpeedChart', () => ({
  default: ({ poolName, dataPoints }: { poolName: string; dataPoints: unknown[] }) => (
    <div data-testid="pool-chart">{`${poolName}:${dataPoints.length}`}</div>
  ),
}));

const { default: ZFSPoolSpeedCharts } = await import('../ZFSPoolSpeedCharts');

function row(host: string, entity: string, entityType: ZFSEntityType, pool = entity.split('/')[0]): ZFSStatsRow {
  return {
    time: 1000,
    host,
    pool,
    entity,
    entity_type: entityType,
    indent: 0,
    capacity_alloc: null,
    capacity_free: null,
    read_ops_per_sec: null,
    write_ops_per_sec: null,
    read_bytes_per_sec: 1,
    write_bytes_per_sec: 2,
    utilization_percent: null,
  };
}

describe('ZFSPoolSpeedCharts', () => {
  it('charts pool rows only, never a host-level row or a device group', () => {
    render(
      <ZFSPoolSpeedCharts
        rows={[
          row('nas01', 'tank', 'pool'),
          row('nas01', 'tank/@logs', 'group'),
          row('nas01', 'tank/mirror-0', 'vdev'),
          row('nas01', '', 'host', ''),
          row('nas01', '', 'agent_outdated', ''),
        ]}
      />,
    );

    expect(screen.getAllByTestId('pool-chart').map((el) => el.textContent)).toEqual(['tank:1']);
  });

  it('renders nothing when no row is a pool', () => {
    const { container } = render(
      <ZFSPoolSpeedCharts rows={[row('old-agent', '', 'agent_outdated', ''), row('nas01', 'tank/@spares', 'group')]} />,
    );

    expect(container.innerHTML).toBe('');
  });
});
