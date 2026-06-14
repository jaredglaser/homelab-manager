import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import MetricCheckboxes, {
  ALL_METRICS,
  METRIC_LABELS,
  type MetricType,
} from '@/components/docker/MetricCheckboxes';

// Base UI's Checkbox renders both a hidden native <input> (carries the label's
// `for` id) and a role="checkbox" button (carries aria-labelledby). Query the
// button by role so the hidden input doesn't produce duplicate label matches.
const box = (metric: MetricType) =>
  screen.getByRole('checkbox', { name: METRIC_LABELS[metric] });

describe('MetricCheckboxes', () => {
  it('renders a labeled checkbox for every metric', () => {
    render(<MetricCheckboxes selected={new Set(ALL_METRICS)} onChange={() => {}} />);
    for (const metric of ALL_METRICS) {
      expect(box(metric)).toBeTruthy();
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(ALL_METRICS.length);
  });

  it('reflects the selected set in each checkbox checked state', () => {
    const selected = new Set<MetricType>(['cpu', 'networkRx']);
    render(<MetricCheckboxes selected={selected} onChange={() => {}} />);
    for (const metric of ALL_METRICS) {
      expect(box(metric).getAttribute('aria-checked')).toBe(
        selected.has(metric) ? 'true' : 'false',
      );
    }
  });

  it('adds an unselected metric on click', () => {
    const onChange = mock();
    render(<MetricCheckboxes selected={new Set<MetricType>(['cpu'])} onChange={onChange} />);
    fireEvent.click(box('memory'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Set<MetricType>;
    expect([...next].sort((a, b) => a.localeCompare(b))).toEqual(['cpu', 'memory']);
  });

  it('removes a selected metric on click when more than one remains', () => {
    const onChange = mock();
    render(<MetricCheckboxes selected={new Set<MetricType>(['cpu', 'memory'])} onChange={onChange} />);
    fireEvent.click(box('cpu'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Set<MetricType>;
    expect([...next]).toEqual(['memory']);
  });

  it('keeps the last metric when clicking the only selected one', () => {
    const onChange = mock();
    render(<MetricCheckboxes selected={new Set<MetricType>(['cpu'])} onChange={onChange} />);
    fireEvent.click(box('cpu'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Set<MetricType>;
    expect([...next]).toEqual(['cpu']);
  });

  it('does not mutate the passed selected set', () => {
    const onChange = mock();
    const selected = new Set<MetricType>(['cpu']);
    render(<MetricCheckboxes selected={selected} onChange={onChange} />);
    fireEvent.click(box('memory'));
    expect([...selected]).toEqual(['cpu']);
  });
});
