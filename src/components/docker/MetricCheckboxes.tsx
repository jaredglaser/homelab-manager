import { memo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

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
        <div key={metric} className="flex items-center gap-2">
          <Checkbox
            id={`metric-${metric}`}
            checked={selected.has(metric)}
            onCheckedChange={() => toggle(metric)}
            className="size-4"
          />
          <Label htmlFor={`metric-${metric}`} className="cursor-pointer">
            {METRIC_LABELS[metric]}
          </Label>
        </div>
      ))}
    </div>
  );
});
