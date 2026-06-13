import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  DateTimePicker,
  formatDateTime,
  getCalendarCells,
  clampMs,
} from '@/components/ui/date-time-picker';

// June 15 2026, 14:30 local time. Constructed from local parts so the
// formatted output is timezone-independent for assertions below.
const BASE = new Date(2026, 5, 15, 14, 30, 0, 0).getTime();

describe('formatDateTime', () => {
  it('formats 24-hour time as MM/DD/YYYY HH:mm', () => {
    expect(formatDateTime(BASE, false)).toBe('06/15/2026 14:30');
  });

  it('formats afternoon 12-hour time with PM meridiem', () => {
    expect(formatDateTime(BASE, true)).toBe('06/15/2026 02:30 PM');
  });

  it('formats midnight as 12 AM in 12-hour mode', () => {
    const midnight = new Date(2026, 0, 1, 0, 5, 0, 0).getTime();
    expect(formatDateTime(midnight, true)).toBe('01/01/2026 12:05 AM');
    expect(formatDateTime(midnight, false)).toBe('01/01/2026 00:05');
  });
});

describe('getCalendarCells', () => {
  it('pads leading blanks to align the 1st to its weekday and lists every day', () => {
    // June 2026: the 1st is a Monday -> one leading blank.
    const days = getCalendarCells(2026, 5).map((c) => c.day);
    expect(days.slice(0, 2)).toEqual([null, 1]);
    expect(days.filter((d) => d != null)).toHaveLength(30);
  });

  it('handles a month whose 1st falls on Sunday with no leading blanks', () => {
    // February 2026 starts on a Sunday.
    const cells = getCalendarCells(2026, 1);
    expect(cells[0].day).toBe(1);
    expect(cells.filter((c) => c.day != null)).toHaveLength(28);
  });

  it('gives every cell a unique, stable key', () => {
    const cells = getCalendarCells(2026, 5);
    const keys = cells.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('clampMs', () => {
  it('returns the value unchanged when within bounds', () => {
    expect(clampMs(50, 0, 100)).toBe(50);
  });
  it('clamps below min and above max', () => {
    expect(clampMs(-5, 0, 100)).toBe(0);
    expect(clampMs(150, 0, 100)).toBe(100);
  });
  it('ignores undefined bounds', () => {
    expect(clampMs(150)).toBe(150);
  });
});

describe('DateTimePicker', () => {
  function setup(props: Partial<React.ComponentProps<typeof DateTimePicker>> = {}) {
    const onChange = mock((_ms: number) => {});
    render(
      <DateTimePicker value={BASE} onChange={onChange} ariaLabel="When" {...props} />,
    );
    return { onChange };
  }

  it('renders the formatted value in the trigger', () => {
    setup();
    expect(screen.getByLabelText('When').textContent).toContain('06/15/2026');
  });

  it('opens the popover and selects a day, emitting the new timestamp', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByLabelText('When'));
    fireEvent.click(screen.getByRole('button', { name: '20' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = new Date(onChange.mock.calls[0][0]);
    expect(next.getDate()).toBe(20);
    expect(next.getHours()).toBe(14); // time preserved
    expect(next.getMinutes()).toBe(30);
  });

  it('navigates to the previous and next month', () => {
    setup();
    fireEvent.click(screen.getByLabelText('When'));
    fireEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText('May 2026')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next month'));
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('July 2026')).toBeTruthy();
  });

  it('wraps the year when navigating across December', () => {
    setup({ value: new Date(2026, 11, 10, 9, 0).getTime() });
    fireEvent.click(screen.getByLabelText('When'));
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('January 2027')).toBeTruthy();
  });

  it('updates the hour in 24-hour mode', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByLabelText('When'));
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '9' } });
    expect(new Date(onChange.mock.calls.at(-1)![0]).getHours()).toBe(9);
  });

  it('updates the minute', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByLabelText('When'));
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '45' } });
    expect(new Date(onChange.mock.calls.at(-1)![0]).getMinutes()).toBe(45);
  });

  it('toggles AM/PM in 12-hour mode', () => {
    const { onChange } = setup({ use12Hour: true });
    fireEvent.click(screen.getByLabelText('When'));
    // 14:30 is PM; toggling should move to 02:30 AM (hour 2).
    fireEvent.click(screen.getByLabelText('Toggle AM/PM'));
    expect(new Date(onChange.mock.calls.at(-1)![0]).getHours()).toBe(2);
  });

  it('maps the 12-hour field back to 24-hour time with the PM offset', () => {
    const { onChange } = setup({ use12Hour: true });
    fireEvent.click(screen.getByLabelText('When'));
    // Entering 5 while PM is active -> 17:00.
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '5' } });
    expect(new Date(onChange.mock.calls.at(-1)![0]).getHours()).toBe(17);
  });

  it('disables days outside the max bound', () => {
    setup({ max: new Date(2026, 5, 16, 23, 59).getTime() });
    fireEvent.click(screen.getByLabelText('When'));
    expect((screen.getByRole('button', { name: '25' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '10' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
