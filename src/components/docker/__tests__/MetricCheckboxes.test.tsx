import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MetricType } from '@/components/docker/MetricCheckboxes';

const { default: MetricCheckboxes } = await import('@/components/docker/MetricCheckboxes');

describe('MetricCheckboxes', () => {
  it('renders all six metric labels', () => {
    render(<MetricCheckboxes selected={new Set(['cpu'])} onChange={() => {}} />);
    screen.getByText('CPU %');
    screen.getByText('Memory %');
    screen.getByText('Block Read');
    screen.getByText('Block Write');
    screen.getByText('Network RX');
    screen.getByText('Network TX');
  });

  it('checks the selected metrics', () => {
    render(<MetricCheckboxes selected={new Set(['cpu', 'memory'])} onChange={() => {}} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // cpu and memory are checked (first two), rest unchecked
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[2] as HTMLInputElement).checked).toBe(false);
  });

  it('calls onChange with updated set when unchecked metric is toggled on', () => {
    let result: Set<MetricType> | null = null;
    render(
      <MetricCheckboxes
        selected={new Set(['cpu'])}
        onChange={(s) => { result = s; }}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // memory checkbox
    expect(result).not.toBeNull();
    expect(result!.has('memory')).toBe(true);
    expect(result!.has('cpu')).toBe(true);
  });

  it('calls onChange without the metric when checked metric is toggled off (multiple selected)', () => {
    let result: Set<MetricType> | null = null;
    render(
      <MetricCheckboxes
        selected={new Set(['cpu', 'memory'])}
        onChange={(s) => { result = s; }}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // uncheck cpu
    expect(result!.has('cpu')).toBe(false);
    expect(result!.has('memory')).toBe(true);
  });

  it('does not remove the last metric when toggling the only selected one', () => {
    let result: Set<MetricType> | null = null;
    render(
      <MetricCheckboxes
        selected={new Set(['cpu'])}
        onChange={(s) => { result = s; }}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // try to uncheck cpu (only one selected)
    // onChange still called but set still contains cpu
    expect(result!.has('cpu')).toBe(true);
  });
});
