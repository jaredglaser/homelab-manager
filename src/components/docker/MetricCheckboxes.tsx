import { memo } from 'react';
import Checkbox from '@mui/joy/Checkbox';

export type MetricType = 'cpu' | 'memory' | 'blockRead' | 'blockWrite' | 'networkRx' | 'networkTx';

export const METRIC_LABELS: Record<MetricType, string> = {
  cpu: 'CPU %',
  memory: 'Memory %',
  blockRead: 'Block Read',
  blockWrite: 'Block Write',
  networkRx: 'Network RX',
  networkTx: 'Network TX',
};

export const ALL_METRICS: MetricType[] = ['cpu', 'memory', 'blockRead', 'blockWrite', 'networkRx', 'networkTx'];

interface MetricCheckboxesProps {
  selected: Set<MetricType>;
  onChange: (metrics: Set<MetricType>) => void;
}

export default memo(function MetricCheckboxes({ selected, onChange }: MetricCheckboxesProps) {
  const toggle = (metric: MetricType) => {
    const next = new Set(selected);
    if (next.has(metric)) {
      if (next.size > 1) next.delete(metric);
    } else {
      next.add(metric);
    }
    onChange(next);
  };

  return (
    <div className="flex flex-wrap gap-3">
      {ALL_METRICS.map((metric) => (
        <Checkbox
          key={metric}
          label={METRIC_LABELS[metric]}
          checked={selected.has(metric)}
          onChange={() => toggle(metric)}
          size="sm"
        />
      ))}
    </div>
  );
});
