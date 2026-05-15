import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';

mock.module('@/components/docker/useContainerHistoryData', () => ({
  useContainerHistoryData: () => ({
    isInfoLoading: false,
    isChartFetching: false,
    isChartDataEmpty: false,
    timelineData: [],
    chartData: [],
    containerName: 'nginx',
    containerImage: 'nginx:latest',
    iconUrl: 'https://icons.example.com/nginx.png',
    iconError: false,
    showServiceKey: false,
    serviceKey: null,
    setIconError: () => {},
    initialRange: { from: 0, to: 1000 },
    timelineRange: { from: 0, to: 1000 },
    activePresetMs: 3600000,
    chartFrom: 0,
    chartTo: 1000,
    selectedMetrics: new Set(['cpu', 'memory']),
    handleMetricsChange: () => {},
    handleRangeChange: () => {},
    handlePresetChange: () => {},
    handleCustomRangeChange: () => {},
  }),
}));

mock.module('@/components/docker/MetricCheckboxes', () => ({
  default: ({ selected }: { selected: Set<string> }) => (
    <div data-testid="metric-checkboxes">{Array.from(selected).join(',')}</div>
  ),
}));

mock.module('@/components/docker/HistoricalChartsGrid', () => ({
  default: () => <div data-testid="charts-grid" />,
}));

mock.module('@/components/docker/HistoricalTimeline', () => ({
  default: () => <div data-testid="timeline" />,
}));

const { default: ContainerHistoryPage } = await import('@/components/docker/ContainerHistoryPage');

function renderPage(overrides: Record<string, unknown> = {}) {
  return render(
    <ContainerHistoryPage
      containerId="abc123"
      host="server1"
      initialMetrics="cpu,memory"
      {...overrides}
    />,
  );
}

describe('ContainerHistoryPage', () => {
  it('renders container name', () => {
    renderPage();
    screen.getByText('nginx');
  });

  it('renders metric checkboxes', () => {
    renderPage();
    screen.getByTestId('metric-checkboxes');
  });

  it('renders charts grid', () => {
    renderPage();
    screen.getByTestId('charts-grid');
  });

  it('renders timeline', () => {
    renderPage();
    screen.getByTestId('timeline');
  });

  it('does not render close button when onClose not provided', () => {
    renderPage();
    expect(screen.queryByLabelText('Close history panel')).toBeNull();
  });

  it('renders close button when onClose provided', () => {
    renderPage({ onClose: () => {} });
    screen.getByLabelText('Close history panel');
  });

  it('calls onClose when close button clicked', () => {
    let closed = false;
    renderPage({ onClose: () => { closed = true; } });
    fireEvent.click(screen.getByLabelText('Close history panel'));
    expect(closed).toBe(true);
  });
});
