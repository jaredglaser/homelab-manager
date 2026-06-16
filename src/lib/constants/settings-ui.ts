import type { DecimalSettings } from '@/hooks/useSettings'

export const CHART_WINDOW_MARKS = [60, 120, 300, 600, 900, 1800];

export const UPDATE_INTERVAL_MARKS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];

export const RAW_DATA_MARKS = [1, 2, 4, 8, 12, 24, 48, 72, 120, 168];
export const MINUTE_AGG_MARKS = [1, 2, 3, 5, 7, 14, 21, 30];
export const HOUR_AGG_MARKS = [1, 7, 14, 30, 60, 90, 180, 365];

export function formatChartWindow(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  return `${minutes} min`;
}

export function formatUpdateInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  return `${minutes}min`;
}

export function formatHours(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = hours / 24;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
  return `${hours} hours`;
}

export function formatDays(days: number): string {
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  if (days % 30 === 0 && days >= 30) {
    const months = days / 30;
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  if (days % 7 === 0 && days < 30) {
    const weeks = days / 7;
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}

const DECIMAL_LABELS: Record<keyof DecimalSettings, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  diskSpeed: 'Disk Speed',
  networkSpeed: 'Network Speed',
};

export function formatDecimalLabel(key: keyof DecimalSettings): string {
  return DECIMAL_LABELS[key];
}
