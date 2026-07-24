import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { DockerStatsRow } from '@/types/docker';
import * as useSettingsModule from '@/hooks/useSettings';

/**
 * The real ReactECharts component pulls in the full echarts runtime (canvas,
 * zrender) which does not work under happy-dom. Replace it with a stub that
 * records the props the component passes (option, onEvents) and exposes a fake
 * instance through the imperative `getEchartsInstance()` ref API the component
 * relies on. Each render's props are pushed to the shared captures below so a
 * test can drive the datazoom callback and assert on dispatched actions.
 */
type FakeInstance = {
  dispatchAction: ReturnType<typeof mock>;
  getOption: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
};

const echartsCaptures: {
  options: unknown[];
  onEventsList: Record<string, (...args: unknown[]) => void>[];
  instance: FakeInstance;
  // Controls what getOption() reports back to the datazoom handler.
  optionResult: { dataZoom: { startValue: string | number; endValue: string | number }[] };
  disposeCalls: number;
} = {
  options: [],
  onEventsList: [],
  instance: {
    dispatchAction: mock(() => {}),
    getOption: mock(() => echartsCaptures.optionResult),
    dispose: mock(() => {}),
  },
  optionResult: { dataZoom: [{ startValue: 1000, endValue: 2000 }] },
  disposeCalls: 0,
};

mock.module('echarts-for-react', () => {
  const { forwardRef, useImperativeHandle, useEffect } = require('react');
  const ReactECharts = forwardRef(function ReactECharts(
    props: { option: unknown; onEvents: Record<string, (...args: unknown[]) => void> },
    ref: unknown,
  ) {
    echartsCaptures.options.push(props.option);
    echartsCaptures.onEventsList.push(props.onEvents);
    useImperativeHandle(ref as never, () => ({
      getEchartsInstance: () => echartsCaptures.instance,
    }));
    useEffect(() => {
      return () => {
        echartsCaptures.disposeCalls += 1;
        echartsCaptures.instance.dispose();
      };
    }, []);
    return null;
  });
  return { __esModule: true, default: ReactECharts };
});

const { default: HistoricalTimeline } = await import('@/components/docker/HistoricalTimeline');
const { RANGE_PRESETS, TIMELINE_METRICS } = await import('@/lib/charts/timeline-chart-config');

function makeRow(timeMs: number, cpu: number): DockerStatsRow {
  return {
    time: timeMs,
    cpu_percent: cpu,
    memory_percent: cpu / 2,
    block_io_read_bytes_per_sec: 0,
    block_io_write_bytes_per_sec: 0,
    network_rx_bytes_per_sec: 0,
    network_tx_bytes_per_sec: 0,
  } as DockerStatsRow;
}

const BASE = new Date(2026, 5, 15, 14, 30, 0, 0).getTime();
const FROM = BASE - 3_600_000;
const TO = BASE;

type Props = React.ComponentProps<typeof HistoricalTimeline>;

function renderTimeline(overrides: Partial<Props> = {}) {
  const onRangeChange = mock((_from: number, _to: number) => {});
  const onPresetChange = mock((_ms: number) => {});
  const onCustomRangeChange = mock((_from: number, _to: number) => {});
  const props: Props = {
    timelineData: [makeRow(FROM, 10), makeRow(BASE - 1_800_000, 20), makeRow(TO, 30)],
    initialFrom: FROM,
    initialTo: TO,
    onRangeChange,
    timelineFrom: FROM,
    timelineTo: TO,
    activePresetMs: null,
    onPresetChange,
    onCustomRangeChange,
    ...overrides,
  };
  const utils = render(<HistoricalTimeline {...props} />);
  return { ...utils, onRangeChange, onPresetChange, onCustomRangeChange, props };
}

let settingsSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  echartsCaptures.options = [];
  echartsCaptures.onEventsList = [];
  echartsCaptures.disposeCalls = 0;
  echartsCaptures.optionResult = { dataZoom: [{ startValue: 1000, endValue: 2000 }] };
  echartsCaptures.instance.dispatchAction = mock(() => {});
  echartsCaptures.instance.getOption = mock(() => echartsCaptures.optionResult);
  echartsCaptures.instance.dispose = mock(() => {});
  settingsSpy = spyOn(useSettingsModule, 'useGeneralSettings').mockImplementation(() => ({
    general: { use12HourTime: false } as never,
    retention: {} as never,
    developer: {} as never,
    setUse12HourTime: () => {},
    setUpdateInterval: () => {},
    setShowSparklines: () => {},
    setUseAbbreviatedUnits: () => {},
    setLightPalette: () => {},
    setRetention: () => {},
    setDockerDebugLogging: () => {},
    setDbFlushDebugLogging: () => {},
    setSseDebugLogging: () => {},
  }));
});

afterEach(() => {
  settingsSpy.mockRestore();
  cleanup();
});

describe('HistoricalTimeline presets', () => {
  it('renders a toggle button for every range preset', () => {
    renderTimeline();
    for (const preset of RANGE_PRESETS) {
      expect(screen.getByRole('button', { name: preset.label })).toBeTruthy();
    }
  });

  it('renders a toggle button for every timeline metric', () => {
    renderTimeline();
    for (const metric of TIMELINE_METRICS) {
      expect(screen.getByRole('button', { name: metric.label })).toBeTruthy();
    }
  });

  it('calls onPresetChange with the preset ms when a preset is clicked', () => {
    const { onPresetChange } = renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: '6h' }));
    expect(onPresetChange).toHaveBeenCalledTimes(1);
    expect(onPresetChange.mock.calls[0][0]).toBe(21_600_000);
    // Preset click resets the slider to the full range.
    expect(echartsCaptures.instance.dispatchAction).toHaveBeenCalledWith({
      type: 'dataZoom',
      start: 0,
      end: 100,
    });
  });

  it('reflects the active preset as pressed', () => {
    renderTimeline({ activePresetMs: 86_400_000 });
    const pressed = screen.getByRole('button', { name: '1d' });
    expect(pressed.getAttribute('data-pressed')).not.toBeNull();
    const other = screen.getByRole('button', { name: '6h' });
    expect(other.getAttribute('data-pressed')).toBeNull();
  });

  it('shows no preset pressed when activePresetMs is null', () => {
    renderTimeline({ activePresetMs: null });
    for (const preset of RANGE_PRESETS) {
      const btn = screen.getByRole('button', { name: preset.label });
      expect(btn.getAttribute('data-pressed')).toBeNull();
    }
  });

  it('switches the active metric when a metric toggle is clicked', () => {
    renderTimeline();
    const optionsBefore = echartsCaptures.options.length;
    fireEvent.click(screen.getByRole('button', { name: 'Mem' }));
    // Changing the metric recomputes the series, which re-renders the chart.
    expect(echartsCaptures.options.length).toBeGreaterThan(optionsBefore);
  });
});

describe('HistoricalTimeline custom date range', () => {
  it('emits a custom range when the From date is moved earlier', () => {
    const { onCustomRangeChange } = renderTimeline();
    fireEvent.click(screen.getByLabelText('From date and time'));
    // June 15 is selected; clicking the 10th keeps it below the To bound.
    const popup = screen.getByText('June 2026').closest('div')!.parentElement as HTMLElement;
    fireEvent.click(within(popup).getByRole('button', { name: '10' }));
    expect(onCustomRangeChange).toHaveBeenCalledTimes(1);
    const [from, to] = onCustomRangeChange.mock.calls[0];
    expect(new Date(from).getDate()).toBe(10);
    expect(to).toBe(TO);
    // Custom change resets the slider to full range.
    expect(echartsCaptures.instance.dispatchAction).toHaveBeenCalledWith({
      type: 'dataZoom',
      start: 0,
      end: 100,
    });
  });

  it('emits a custom range when the To date is moved later', () => {
    const { onCustomRangeChange } = renderTimeline();
    fireEvent.click(screen.getByLabelText('To date and time'));
    const popup = screen.getByText('June 2026').closest('div')!.parentElement as HTMLElement;
    fireEvent.click(within(popup).getByRole('button', { name: '20' }));
    expect(onCustomRangeChange).toHaveBeenCalledTimes(1);
    const [from, to] = onCustomRangeChange.mock.calls[0];
    expect(from).toBe(FROM);
    expect(new Date(to).getDate()).toBe(20);
  });

  it('ignores a From change that is not before the To bound', () => {
    // From == To violates the from < to guard, so no callback fires.
    const { onCustomRangeChange } = renderTimeline({ timelineFrom: TO, timelineTo: TO });
    fireEvent.click(screen.getByLabelText('From date and time'));
    const hourInput = screen.getByLabelText('Hour');
    // Selecting the same day/time keeps ms >= timelineTo.
    fireEvent.change(hourInput, { target: { value: String(new Date(TO).getHours()) } });
    expect(onCustomRangeChange).not.toHaveBeenCalled();
  });
});

describe('HistoricalTimeline echarts wiring', () => {
  it('renders the chart with an option on mount', () => {
    renderTimeline();
    expect(echartsCaptures.options.length).toBeGreaterThan(0);
    expect(echartsCaptures.options[0]).toBeDefined();
  });

  it('positions the slider to the initial range after mount', () => {
    renderTimeline();
    expect(echartsCaptures.instance.dispatchAction).toHaveBeenCalledWith({
      type: 'dataZoom',
      startValue: FROM,
      endValue: TO,
    });
  });

  it('does not position the slider when there is no data', () => {
    renderTimeline({ timelineData: [] });
    const initialDispatch = echartsCaptures.instance.dispatchAction.mock.calls.filter(
      (c) => (c[0] as { startValue?: number }).startValue != null,
    );
    expect(initialDispatch.length).toBe(0);
  });

  it('re-renders the chart option when timelineData changes', () => {
    const { rerender, props } = renderTimeline();
    const before = echartsCaptures.options.length;
    rerender(
      <HistoricalTimeline
        {...props}
        timelineData={[makeRow(FROM, 99), makeRow(TO, 88)]}
      />,
    );
    expect(echartsCaptures.options.length).toBeGreaterThan(before);
  });

  it('disposes the chart on unmount', () => {
    const { unmount } = renderTimeline();
    unmount();
    expect(echartsCaptures.disposeCalls).toBeGreaterThan(0);
  });
});

describe('HistoricalTimeline datazoom handler', () => {
  function fireDatazoom() {
    const onEvents = echartsCaptures.onEventsList.at(-1)!;
    onEvents.datazoom();
  }

  it('forwards rounded numeric start/end to onRangeChange', () => {
    const { onRangeChange } = renderTimeline();
    echartsCaptures.optionResult = { dataZoom: [{ startValue: 1000.6, endValue: 2000.4 }] };
    fireDatazoom();
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange.mock.calls[0]).toEqual([1001, 2000]);
  });

  it('coerces date-string zoom bounds into timestamps', () => {
    const { onRangeChange } = renderTimeline();
    const startIso = new Date(FROM).toISOString();
    const endIso = new Date(TO).toISOString();
    echartsCaptures.optionResult = { dataZoom: [{ startValue: startIso, endValue: endIso }] };
    fireDatazoom();
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange.mock.calls[0]).toEqual([FROM, TO]);
  });

  it('ignores datazoom events with missing bounds', () => {
    const { onRangeChange } = renderTimeline();
    echartsCaptures.optionResult = { dataZoom: [{ startValue: null as never, endValue: 2000 }] };
    fireDatazoom();
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('ignores datazoom events with non-numeric date strings', () => {
    const { onRangeChange } = renderTimeline();
    echartsCaptures.optionResult = { dataZoom: [{ startValue: 'not-a-date', endValue: 'also-bad' }] };
    fireDatazoom();
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('suppresses the datazoom that a preset click triggers', () => {
    const { onRangeChange, onPresetChange } = renderTimeline();
    // A preset click arms suppressZoomRef; the next datazoom event is swallowed.
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    expect(onPresetChange).toHaveBeenCalledTimes(1);
    echartsCaptures.optionResult = { dataZoom: [{ startValue: 1000, endValue: 2000 }] };
    fireDatazoom();
    expect(onRangeChange).not.toHaveBeenCalled();
    // The following datazoom is no longer suppressed.
    fireDatazoom();
    expect(onRangeChange).toHaveBeenCalledTimes(1);
  });
});
