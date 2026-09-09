import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { EChartsOption } from 'echarts';

const capturedOptions: EChartsOption[] = [];

mock.module('echarts-for-react', () => ({
  __esModule: true,
  default: (props: { option: EChartsOption }) => {
    capturedOptions.push(props.option);
    return <div data-testid="react-echarts" />;
  },
}));

mock.module('@/hooks/useSettings', () => ({
  useGeneralSettings: () => ({
    general: { use12HourTime: false },
    retention: {},
    developer: {},
  }),
}));

const isMobile = { value: false };

mock.module('@/hooks/useMediaQuery', () => ({
  useIsMobile: () => isMobile.value,
}));

const { default: ZFSPoolSpeedChart } = await import('@/components/zfs/ZFSPoolSpeedChart');

const dataPoints = [
  { timestamp: Date.now() - 30_000, readBytesPerSec: 1_000_000, writeBytesPerSec: 500_000 },
  { timestamp: Date.now(), readBytesPerSec: 2_000_000, writeBytesPerSec: 750_000 },
];

function lastOption(): Record<string, unknown> {
  return capturedOptions[capturedOptions.length - 1] as Record<string, unknown>;
}

describe('ZFSPoolSpeedChart', () => {
  beforeEach(() => {
    capturedOptions.length = 0;
    isMobile.value = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the pool name and an echarts canvas', () => {
    render(<ZFSPoolSpeedChart poolName="rust" dataPoints={dataPoints} />);
    expect(screen.getByText('rust')).not.toBeNull();
    expect(screen.getByTestId('react-echarts')).not.toBeNull();
  });

  it('uses the desktop grid margins when the container is not mobile-width', () => {
    isMobile.value = false;
    render(<ZFSPoolSpeedChart poolName="rust" dataPoints={dataPoints} />);
    const grid = lastOption().grid as { top: number; right: number; bottom: number; left: number };
    expect(grid).toEqual({ top: 10, right: 15, bottom: 45, left: 55 });
  });

  it('tightens the grid margins on mobile so more of a 375px viewport is plot area', () => {
    isMobile.value = true;
    render(<ZFSPoolSpeedChart poolName="rust" dataPoints={dataPoints} />);
    const grid = lastOption().grid as { top: number; right: number; bottom: number; left: number };
    expect(grid.left).toBeLessThan(55);
    expect(grid.right).toBeLessThan(15);
    expect(grid.bottom).toBeLessThan(45);
  });
});
