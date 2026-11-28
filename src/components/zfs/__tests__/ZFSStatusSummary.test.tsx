import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import ZFSStatusSummary from '../ZFSStatusSummary';
import type { ZFSStatsRow } from '@/types/zfs';

function makeRow(overrides: Partial<ZFSStatsRow> & Pick<ZFSStatsRow, 'host' | 'entity_type'>): ZFSStatsRow {
  return {
    time: 1000,
    pool: 'tank',
    entity: 'tank',
    indent: 0,
    capacity_alloc: null,
    capacity_free: null,
    read_ops_per_sec: null,
    write_ops_per_sec: null,
    read_bytes_per_sec: null,
    write_bytes_per_sec: null,
    utilization_percent: null,
    ...overrides,
  };
}

function makeMap(rows: ZFSStatsRow[]): Map<string, ZFSStatsRow> {
  const map = new Map<string, ZFSStatsRow>();
  for (const row of rows) {
    const key = row.host ? `${row.host}/${row.entity}` : row.entity;
    map.set(key, row);
  }
  return map;
}

function segment(label: string): string | null | undefined {
  return screen.getByText(label).parentElement?.textContent;
}

describe('ZFSStatusSummary', () => {
  it('shows "0 pools" when map is empty', () => {
    render(<ZFSStatusSummary latestByEntity={new Map()} />);
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText('pools')).toBeDefined();
  });

  it('always shows pools segment even at zero', () => {
    render(<ZFSStatusSummary latestByEntity={new Map()} />);
    expect(screen.getByText('pools')).toBeDefined();
    expect(screen.queryByText('disks')).toBeNull();
  });

  it('counts pools from entity_type', () => {
    const map = makeMap([
      makeRow({ host: 'server1', entity: 'tank', entity_type: 'pool' }),
      makeRow({ host: 'server1', entity: 'rpool', entity_type: 'pool' }),
    ]);
    render(<ZFSStatusSummary latestByEntity={map} />);
    expect(screen.getByText('pools')).toBeDefined();
    const twos = screen.getAllByText('2');
    expect(twos.length).toBeGreaterThan(0);
  });

  it('counts disks from entity_type', () => {
    const map = makeMap([
      makeRow({ host: 'server1', entity: 'tank', entity_type: 'pool' }),
      makeRow({ host: 'server1', entity: 'tank/mirror-0/sda', entity_type: 'disk', indent: 4 }),
      makeRow({ host: 'server1', entity: 'tank/mirror-0/sdb', entity_type: 'disk', indent: 4 }),
    ]);
    render(<ZFSStatusSummary latestByEntity={map} />);
    expect(screen.getByText('disks')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('omits disk segment when no disks', () => {
    const map = makeMap([
      makeRow({ host: 'server1', entity: 'tank', entity_type: 'pool' }),
    ]);
    render(<ZFSStatusSummary latestByEntity={map} />);
    expect(screen.queryByText('disks')).toBeNull();
  });

  it('counts distinct hosts', () => {
    const map = makeMap([
      makeRow({ host: 'server1', entity: 'tank', entity_type: 'pool' }),
      makeRow({ host: 'server2', entity: 'tank', entity_type: 'pool' }),
    ]);
    render(<ZFSStatusSummary latestByEntity={map} />);
    expect(screen.getByText('hosts')).toBeDefined();
    const twos = screen.getAllByText('2');
    expect(twos.length).toBeGreaterThan(0);
  });

  it('omits host segment when map is empty', () => {
    render(<ZFSStatusSummary latestByEntity={new Map()} />);
    expect(screen.queryByText('hosts')).toBeNull();
  });

  it('does not count vdev entities in any segment', () => {
    const map = makeMap([
      makeRow({ host: 'server1', entity: 'tank', entity_type: 'pool' }),
      makeRow({ host: 'server1', entity: 'tank/mirror-0', entity_type: 'vdev', indent: 2 }),
    ]);
    render(<ZFSStatusSummary latestByEntity={map} />);
    // pools=1, hosts=1, no disks, no vdev label
    const ones = screen.getAllByText('1');
    expect(ones.length).toBeGreaterThan(0);
    expect(screen.queryByText('disks')).toBeNull();
    expect(screen.queryByText('vdevs')).toBeNull();
  });

  it('renders middle-dot separators between segments', () => {
    const map = makeMap([
      makeRow({ host: 'server1', entity: 'tank', entity_type: 'pool' }),
      makeRow({ host: 'server1', entity: 'tank/mirror-0/sda', entity_type: 'disk', indent: 4 }),
    ]);
    render(<ZFSStatusSummary latestByEntity={map} />);
    const dots = screen.getAllByText('·');
    expect(dots.length).toBeGreaterThan(0);
  });

  it('counts only the newest sample of each host, so an exported pool drops out', () => {
    render(
      <ZFSStatusSummary
        latestByEntity={makeMap([
          makeRow({ host: 'h1', entity_type: 'pool', entity: 'old', pool: 'old', time: 1000 }),
          makeRow({ host: 'h1', entity_type: 'pool', entity: 'tank', time: 2000 }),
          makeRow({ host: 'h1', entity_type: 'disk', entity: 'tank/sda', time: 2000 }),
        ])}
      />,
    );
    expect(segment('pools')).toBe('1 pools');
    expect(segment('disks')).toBe('1 disks');
  });

  it('shows no pools once the host reports a sample with none', () => {
    render(
      <ZFSStatusSummary
        latestByEntity={makeMap([
          makeRow({ host: 'h1', entity_type: 'pool', entity: 'tank', time: 1000 }),
          makeRow({ host: 'h1', entity_type: 'host', entity: '', pool: '', time: 2000 }),
        ])}
      />,
    );
    expect(segment('pools')).toBe('0 pools');
  });
});
