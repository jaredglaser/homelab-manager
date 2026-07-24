import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ContainerHistoryData } from '@/components/docker/useContainerHistoryData';
import type { MetricType } from '@/components/docker/MetricCheckboxes';
import type { DockerStatsRow } from '@/types/docker';

const handleMetricsChange = mock((_metrics: Set<MetricType>) => {});
const handleRangeChange = mock((_from: number, _to: number) => {});
const handlePresetChange = mock((_ms: number) => {});
const handleCustomRangeChange = mock((_from: number, _to: number) => {});

const sampleRow = { time: Date.parse('2024-01-01T00:00:00Z'), host: 'server', container_id: 'abc' } as DockerStatsRow;

function makeHookData(overrides: Partial<ContainerHistoryData> = {}): ContainerHistoryData {
  return {
    isChartDataEmpty: false,
    timelineData: [sampleRow],
    chartData: [sampleRow],
    initialRange: { from: 1000, to: 2000 },
    timelineRange: { from: 1100, to: 2100 },
    activePresetMs: 3_600_000,
    chartFrom: 1200,
    chartTo: 2200,
    selectedMetrics: new Set<MetricType>(['cpu']),
    handleMetricsChange,
    handleRangeChange,
    handlePresetChange,
    handleCustomRangeChange,
    ...overrides,
  };
}

let hookData: ContainerHistoryData = makeHookData();
const useContainerHistoryDataMock = mock(() => hookData);
const hookParamsSpy = mock((_params: unknown) => {});

mock.module('@/components/docker/useContainerHistoryData', () => ({
  useContainerHistoryData: (params: unknown) => {
    hookParamsSpy(params);
    return useContainerHistoryDataMock();
  },
}));

mock.module('@/components/docker/MetricCheckboxes', () => ({
  default: (props: { selected: Set<MetricType>; onChange: (m: Set<MetricType>) => void }) => (
    <div data-testid="metric-checkboxes" data-selected={[...props.selected].join(',')}>
      <button
        type="button"
        data-testid="metrics-change"
        onClick={() => props.onChange(new Set<MetricType>(['memory']))}
      >
        change metrics
      </button>
    </div>
  ),
}));

mock.module('@/components/docker/HistoricalChartsGrid', () => ({
  default: (props: { data: DockerStatsRow[]; selectedMetrics: Set<MetricType>; from: number; to: number }) => (
    <div
      data-testid="charts-grid"
      data-selected={[...props.selectedMetrics].join(',')}
      data-from={props.from}
      data-to={props.to}
      data-rows={props.data.length}
    />
  ),
}));

mock.module('@/components/docker/HistoricalTimeline', () => ({
  default: (props: {
    timelineData: DockerStatsRow[];
    initialFrom: number;
    initialTo: number;
    timelineFrom: number;
    timelineTo: number;
    activePresetMs: number | null;
    onRangeChange: (from: number, to: number) => void;
    onPresetChange: (ms: number) => void;
    onCustomRangeChange: (from: number, to: number) => void;
  }) => (
    <div
      data-testid="timeline"
      data-rows={props.timelineData.length}
      data-initial-from={props.initialFrom}
      data-initial-to={props.initialTo}
      data-timeline-from={props.timelineFrom}
      data-timeline-to={props.timelineTo}
      data-active-preset={props.activePresetMs ?? 'null'}
    >
      <button type="button" data-testid="range-change" onClick={() => props.onRangeChange(10, 20)}>
        range
      </button>
      <button type="button" data-testid="preset-change" onClick={() => props.onPresetChange(86_400_000)}>
        preset
      </button>
      <button type="button" data-testid="custom-change" onClick={() => props.onCustomRangeChange(30, 40)}>
        custom
      </button>
    </div>
  ),
}));

const { default: ContainerHistoryPage } = await import('@/components/docker/ContainerHistoryPage');

function renderPage(props: Partial<Parameters<typeof ContainerHistoryPage>[0]> = {}) {
  return render(<ContainerHistoryPage containerId="abc" initialMetrics="cpu" {...props} />);
}

describe('ContainerHistoryPage', () => {
  beforeEach(() => {
    hookData = makeHookData();
    useContainerHistoryDataMock.mockClear();
    hookParamsSpy.mockClear();
    handleMetricsChange.mockClear();
    handleRangeChange.mockClear();
    handlePresetChange.mockClear();
    handleCustomRangeChange.mockClear();
  });

  it('renders all three child sections', () => {
    renderPage();
    expect(screen.getByTestId('metric-checkboxes')).toBeDefined();
    expect(screen.getByTestId('charts-grid')).toBeDefined();
    expect(screen.getByTestId('timeline')).toBeDefined();
  });

  it('forwards its props to the data hook', () => {
    renderPage({ containerId: 'cid', host: 'h1', initialMetrics: 'cpu,memory', initialFrom: 5, initialTo: 9 });
    expect(hookParamsSpy).toHaveBeenCalledWith({
      containerId: 'cid',
      host: 'h1',
      initialMetrics: 'cpu,memory',
      initialFrom: 5,
      initialTo: 9,
    });
  });

  it('passes selectedMetrics to the checkboxes', () => {
    hookData = makeHookData({ selectedMetrics: new Set<MetricType>(['cpu', 'memory']) });
    renderPage();
    expect(screen.getByTestId('metric-checkboxes').getAttribute('data-selected')).toBe('cpu,memory');
  });

  it('passes chart data, selected metrics, and chart bounds to the charts grid', () => {
    hookData = makeHookData({
      chartData: [sampleRow, sampleRow],
      selectedMetrics: new Set<MetricType>(['cpu', 'networkRx']),
      chartFrom: 1200,
      chartTo: 2200,
    });
    renderPage();
    const grid = screen.getByTestId('charts-grid');
    expect(grid.getAttribute('data-rows')).toBe('2');
    expect(grid.getAttribute('data-selected')).toBe('cpu,networkRx');
    expect(grid.getAttribute('data-from')).toBe('1200');
    expect(grid.getAttribute('data-to')).toBe('2200');
  });

  it('passes timeline data, ranges, and active preset to the timeline', () => {
    hookData = makeHookData({
      timelineData: [sampleRow, sampleRow, sampleRow],
      initialRange: { from: 1000, to: 2000 },
      timelineRange: { from: 1100, to: 2100 },
      activePresetMs: 3_600_000,
    });
    renderPage();
    const timeline = screen.getByTestId('timeline');
    expect(timeline.getAttribute('data-rows')).toBe('3');
    expect(timeline.getAttribute('data-initial-from')).toBe('1000');
    expect(timeline.getAttribute('data-initial-to')).toBe('2000');
    expect(timeline.getAttribute('data-timeline-from')).toBe('1100');
    expect(timeline.getAttribute('data-timeline-to')).toBe('2100');
    expect(timeline.getAttribute('data-active-preset')).toBe('3600000');
  });

  it('renders the empty placeholder instead of the charts grid when chart data is empty', () => {
    hookData = makeHookData({ isChartDataEmpty: true });
    renderPage();
    expect(screen.queryByTestId('charts-grid')).toBeNull();
    expect(screen.getByText('No data available for this time range.')).toBeDefined();
  });

  it('renders the charts grid and no placeholder when chart data is present', () => {
    renderPage();
    expect(screen.getByTestId('charts-grid')).toBeDefined();
    expect(screen.queryByText('No data available for this time range.')).toBeNull();
  });

  it('still renders the timeline in the empty branch', () => {
    hookData = makeHookData({ isChartDataEmpty: true });
    renderPage();
    expect(screen.getByTestId('timeline')).toBeDefined();
  });

  it('invokes the metrics change handler when the checkboxes call onChange', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('metrics-change'));
    expect(handleMetricsChange).toHaveBeenCalledWith(new Set<MetricType>(['memory']));
  });

  it('invokes the range change handler when the timeline calls onRangeChange', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('range-change'));
    expect(handleRangeChange).toHaveBeenCalledWith(10, 20);
  });

  it('invokes the preset change handler when the timeline calls onPresetChange', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('preset-change'));
    expect(handlePresetChange).toHaveBeenCalledWith(86_400_000);
  });

  it('invokes the custom range handler when the timeline calls onCustomRangeChange', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('custom-change'));
    expect(handleCustomRangeChange).toHaveBeenCalledWith(30, 40);
  });

  it('passes a null active preset through to the timeline', () => {
    hookData = makeHookData({ activePresetMs: null });
    renderPage();
    expect(screen.getByTestId('timeline').getAttribute('data-active-preset')).toBe('null');
  });
});
