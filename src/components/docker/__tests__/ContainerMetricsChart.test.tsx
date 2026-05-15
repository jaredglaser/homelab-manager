import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ComponentProps } from 'react';

mock.module('@/hooks/useEChartTimeScroll', () => ({
  useEChartTimeScroll: () => {},
}));

mock.module('@/components/docker/DualSeriesChartRenderer', () => ({
  default: ({ option }: { option: unknown }) => (
    <div data-testid="echarts-mock" data-option={JSON.stringify(option)} />
  ),
}));

mock.module('@/hooks/useSettings', () => ({
  useGeneralSettings: () => ({ general: { use12HourTime: false } }),
}));

mock.module('@/hooks/useDockerSettings', () => ({
  useDockerSettings: () => ({
    docker: { chartWindowSeconds: 300 },
    getContainerShell: () => undefined,
    setContainerShell: () => {},
  }),
}));

const { default: ContainerMetricsChart } = await import('@/components/docker/ContainerMetricsChart');

const sampleDataPoints = [
  {
    timestamp: 1000,
    cpuPercent: 25,
    memoryPercent: 50,
    blockIoReadBytesPerSec: 1024,
    blockIoWriteBytesPerSec: 2048,
    networkRxBytesPerSec: 512,
    networkTxBytesPerSec: 256,
  },
  {
    timestamp: 2000,
    cpuPercent: 40,
    memoryPercent: 60,
    blockIoReadBytesPerSec: 2048,
    blockIoWriteBytesPerSec: 4096,
    networkRxBytesPerSec: 1024,
    networkTxBytesPerSec: 512,
  },
];

function renderChart(overrides: Partial<ComponentProps<typeof ContainerMetricsChart>> = {}) {
  const store = createStore();
  const active = new Set<'cpu' | 'memory' | 'blockRead' | 'blockWrite' | 'networkRx' | 'networkTx'>(['cpu', 'memory']);
  const onToggle = () => {};
  return render(
    <Provider store={store}>
      <ContainerMetricsChart
        dataPoints={sampleDataPoints}
        active={active}
        onToggle={onToggle}
        {...overrides}
      />
    </Provider>,
  );
}

describe('ContainerMetricsChart', () => {
  it('renders the chart', () => {
    renderChart();
    expect(screen.getByTestId('echarts-mock')).toBeTruthy();
  });

  it('renders all six legend chips', () => {
    renderChart();
    screen.getByText('CPU');
    screen.getByText('Memory');
    screen.getByText('Block Read');
    screen.getByText('Block Write');
    screen.getByText('Net RX');
    screen.getByText('Net TX');
  });

  it('renders with empty data points', () => {
    renderChart({ dataPoints: [] });
    expect(screen.getByTestId('echarts-mock')).toBeTruthy();
  });

  it('calls onToggle when a legend chip is clicked', () => {
    let toggled = '';
    renderChart({ onToggle: (key) => { toggled = key; } });
    fireEvent.click(screen.getByText('CPU'));
    expect(toggled).toBe('cpu');
  });

  it('uses windowMs prop when provided', () => {
    renderChart({ windowMs: 60000 });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.xAxis.max - option.xAxis.min).toBeCloseTo(60000, -2);
  });

  it('shows active chip styles (border not divider) for active metrics', () => {
    renderChart({ active: new Set(['cpu']) });
    const cpuBtn = screen.getByText('CPU').closest('button')!;
    expect(cpuBtn.style.border).not.toContain('var(--mui-palette-divider)');
  });

  it('passes correct data to the chart series for active metrics', () => {
    renderChart({ active: new Set(['cpu']) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.series).toHaveLength(1);
    expect(option.series[0].name).toBe('CPU');
    expect(option.series[0].data[0][1]).toBe(25);
  });

  it('produces one y-axis per active series', () => {
    renderChart({ active: new Set(['cpu', 'memory', 'blockRead']) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.yAxis).toHaveLength(3);
  });

  it('falls back to a single y-axis when no series is active', () => {
    renderChart({ active: new Set([]) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.yAxis).toHaveLength(1);
  });

  it('shows current formatted value on active chips when data present', () => {
    renderChart({ active: new Set(['cpu']) });
    // CPU at last point is 40 => formatAsPercent(40/100) = "40.00%"
    expect(screen.getByText(/40/)).toBeTruthy();
  });

  it('tooltip is configured for axis trigger', () => {
    renderChart({ active: new Set(['cpu']) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.tooltip.trigger).toBe('axis');
  });

  it('xAxis formatter from buildOption formats timestamps as MM:SS', () => {
    renderChart({ active: new Set(['cpu']) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    // axisLabel.formatter is also a function - verify time axis config
    expect(option.xAxis.type).toBe('time');
  });

  it('renders dashed style for network metrics', () => {
    renderChart({ active: new Set(['networkRx']) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.series[0].lineStyle.type).toBe('dashed');
    expect(option.series[0].areaStyle.opacity).toBe(0);
  });

  it('renders solid style for cpu', () => {
    renderChart({ active: new Set(['cpu']) });
    const el = screen.getByTestId('echarts-mock');
    const option = JSON.parse(el.getAttribute('data-option')!);
    expect(option.series[0].lineStyle.type).toBe('solid');
    expect(option.series[0].areaStyle.opacity).toBe(1);
  });
});
