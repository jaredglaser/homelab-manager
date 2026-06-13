import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils/cn';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a timestamp as `MM/DD/YYYY hh:mm A` (12h) or `MM/DD/YYYY HH:mm` (24h). */
export function formatDateTime(ms: number, use12Hour: boolean): string {
  const d = new Date(ms);
  const date = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  if (use12Hour) {
    const h12 = ((d.getHours() + 11) % 12) + 1;
    const meridiem = d.getHours() < 12 ? 'AM' : 'PM';
    return `${date} ${pad2(h12)}:${pad2(d.getMinutes())} ${meridiem}`;
  }
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export interface CalendarCell {
  /** Stable React key (blank slots key off their weekday, day cells off the date). */
  key: string;
  /** Day of month, or null for a leading blank that aligns the 1st to its weekday. */
  day: number | null;
}

/** Day-of-month cells for a month grid, with leading blanks aligning the 1st to its weekday. */
export function getCalendarCells(year: number, month: number): CalendarCell[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: CalendarCell[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push({ key: `blank-${WEEKDAYS[i]}`, day: null });
  for (let d = 1; d <= daysInMonth; d += 1) cells.push({ key: `day-${d}`, day: d });
  return cells;
}

/** Clamp a timestamp into the optional [min, max] window. */
export function clampMs(ms: number, min?: number, max?: number): number {
  let next = ms;
  if (min != null && next < min) next = min;
  if (max != null && next > max) next = max;
  return next;
}

interface DateTimePickerProps {
  value: number;
  onChange: (ms: number) => void;
  min?: number;
  max?: number;
  use12Hour?: boolean;
  ariaLabel?: string;
  className?: string;
}

/**
 * Composed date + time picker (Base UI Popover + a hand-built month grid and
 * time fields). Values are epoch milliseconds; selections are clamped into
 * [min, max] but the parent is still expected to guard cross-field constraints
 * (e.g. from < to).
 */
export function DateTimePicker({
  value,
  onChange,
  min,
  max,
  use12Hour = false,
  ariaLabel,
  className,
}: Readonly<DateTimePickerProps>) {
  const selected = new Date(value);
  const [view, setView] = useState({ year: selected.getFullYear(), month: selected.getMonth() });

  // Re-anchor the visible month to the selected value each time the popup opens.
  const handleOpenChange = (open: boolean) => {
    if (open) setView({ year: selected.getFullYear(), month: selected.getMonth() });
  };

  const commit = (next: Date) => onChange(clampMs(next.getTime(), min, max));

  const selectDay = (day: number) => {
    const next = new Date(value);
    next.setFullYear(view.year, view.month, day);
    commit(next);
  };

  const setHours24 = (h24: number) => {
    const next = new Date(value);
    next.setHours(h24);
    commit(next);
  };

  const setMinutes = (m: number) => {
    const next = new Date(value);
    next.setMinutes(m);
    commit(next);
  };

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const m = v.month + delta;
      return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });
  };

  const cells = getCalendarCells(view.year, view.month);
  const hours = selected.getHours();
  const displayHour = use12Hour ? ((hours + 11) % 12) + 1 : hours;
  const isPm = hours >= 12;

  // Disable a day only when its entire span falls outside [min, max].
  const isDayDisabled = (day: number): boolean => {
    const start = new Date(view.year, view.month, day).getTime();
    const end = new Date(view.year, view.month, day, 23, 59, 59, 999).getTime();
    return (min != null && end < min) || (max != null && start > max);
  };

  const inputCls =
    'h-8 w-12 rounded-lg border border-foreground/25 bg-transparent px-1 text-center text-sm tabular-nums outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary';

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-8 items-center justify-between gap-2 rounded-lg border border-foreground/25 bg-transparent px-3 text-sm whitespace-nowrap tabular-nums transition-colors outline-none hover:border-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary data-[popup-open]:border-primary',
          className,
        )}
      >
        {formatDateTime(value, use12Hour)}
        <CalendarDays className="size-4 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-auto">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-medium">
            {MONTHS[view.month]} {view.year}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center">
          {WEEKDAYS.map((w) => (
            <span key={w} className="py-1 text-xs text-muted-foreground">
              {w}
            </span>
          ))}
          {cells.map(({ key, day }) => {
            if (day == null) return <span key={key} />;
            const isSelected =
              day === selected.getDate() &&
              view.month === selected.getMonth() &&
              view.year === selected.getFullYear();
            const disabled = isDayDisabled(day);
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => selectDay(day)}
                className={cn(
                  'h-8 w-8 rounded-md text-sm tabular-nums transition-colors',
                  isSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent disabled:pointer-events-none disabled:opacity-30',
                )}
              >
                {day}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-center gap-1.5 border-t border-border pt-3">
          <input
            type="number"
            aria-label="Hour"
            min={use12Hour ? 1 : 0}
            max={use12Hour ? 12 : 23}
            value={displayHour}
            onChange={(e) => {
              // type=number keeps this numeric; an empty field reads as 0.
              const raw = Number(e.target.value);
              if (use12Hour) {
                const clamped = Math.min(12, Math.max(1, raw));
                const base = clamped % 12; // 12 -> 0
                setHours24(isPm ? base + 12 : base);
              } else {
                setHours24(Math.min(23, Math.max(0, raw)));
              }
            }}
            className={inputCls}
          />
          <span className="text-muted-foreground">:</span>
          <input
            type="number"
            aria-label="Minute"
            min={0}
            max={59}
            value={pad2(selected.getMinutes())}
            onChange={(e) => {
              const raw = Number(e.target.value);
              if (Number.isNaN(raw)) return;
              setMinutes(Math.min(59, Math.max(0, raw)));
            }}
            className={inputCls}
          />
          {use12Hour && (
            <button
              type="button"
              aria-label="Toggle AM/PM"
              onClick={() => setHours24(isPm ? hours - 12 : hours + 12)}
              className="h-8 rounded-lg border border-foreground/25 px-2 text-sm font-medium hover:border-foreground"
            >
              {isPm ? 'PM' : 'AM'}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
