import { memo, useMemo } from 'react';
import type { DockerStatsRow } from '@/types/docker';
import { formatAsPercent, formatBytes, formatBitsSIUnits } from '@/formatters/metrics';
import HistoricalMetricChart from '@/components/docker/HistoricalMetricChart';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

interface HistoricalChartsGridProps {
  data: DockerStatsRow[];
  selectedMetrics: Set<MetricType>;
  from: number;
  to: number;
}

interface MetricConfig {
  label: string;
  colorVar: string;
  extract: (row: DockerStatsRow) => number;
  formatValue: (value: number) => string;
}

const METRIC_CONFIGS: Record<MetricType, MetricConfig> = {
  cpu: {
    label: 'CPU %',
    colorVar: '--chart-cpu',
    extract: (r) => r.cpu_percent ?? 0,
    formatValue: (v) => formatAsPercent(v / 100),
  },
  memory: {
    label: 'Memory %',
    colorVar: '--chart-memory',
    extract: (r) => r.memory_percent ?? 0,
    formatValue: (v) => formatAsPercent(v / 100),
  },
  blockRead: {
    label: 'Block Read',
    colorVar: '--chart-read',
    extract: (r) => r.block_io_read_bytes_per_sec ?? 0,
    formatValue: (v) => formatBytes(v, true),
  },
  blockWrite: {
    label: 'Block Write',
    colorVar: '--chart-write',
    extract: (r) => r.block_io_write_bytes_per_sec ?? 0,
    formatValue: (v) => formatBytes(v, true),
  },
  networkRx: {
    label: 'Network RX',
    colorVar: '--chart-read',
    extract: (r) => r.network_rx_bytes_per_sec ?? 0,
    formatValue: (v) => formatBitsSIUnits(v * 8, true),
  },
  networkTx: {
    label: 'Network TX',
    colorVar: '--chart-write',
    extract: (r) => r.network_tx_bytes_per_sec ?? 0,
    formatValue: (v) => formatBitsSIUnits(v * 8, true),
  },
};

/**
 * Selects a Tailwind CSS grid-column class string based on the number of items to display.
 *
 * @param count - The number of metric charts to layout
 * @returns `'grid-cols-1'` when `count` is 1; `'grid-cols-1 xl:grid-cols-2'` when `count` is 2 or greater
 */
function getGridClass(count: number): string {
  switch (count) {
    case 1: return 'grid-cols-1';
    case 2: return 'grid-cols-1 xl:grid-cols-2';
    default: return 'grid-cols-1 xl:grid-cols-2';
  }
}

export default memo(function HistoricalChartsGrid({
  data,
  selectedMetrics,
  from,
  to,
}: HistoricalChartsGridProps) {
  const chartDataByMetric = useMemo(() => {
    const result: Partial<Record<MetricType, { timestamp: number; value: number }[]>> = {};
    for (const metric of selectedMetrics) {
      const config = METRIC_CONFIGS[metric];
      result[metric] = data.map((row) => ({
        timestamp: new Date(row.time).getTime(),
        value: config.extract(row),
      }));
    }
    return result;
  }, [data, selectedMetrics]);

  const metrics = Array.from(selectedMetrics);

  return (
    <div className={`grid ${getGridClass(metrics.length)} gap-3`}>
      {metrics.map((metric) => {
        const config = METRIC_CONFIGS[metric];
        const dataPoints = chartDataByMetric[metric] ?? [];
        return (
          <HistoricalMetricChart
            key={metric}
            title={config.label}
            dataPoints={dataPoints}
            colorVar={config.colorVar}
            formatValue={config.formatValue}
            from={from}
            to={to}
          />
        );
      })}
    </div>
  );
});
