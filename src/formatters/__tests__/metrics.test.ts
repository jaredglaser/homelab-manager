import { describe, it, expect } from 'bun:test';
import {
  formatAsPercent,
  formatAsPercentParts,
  formatBytes,
  formatBytesParts,
  formatBitsSIUnits,
  formatBitsSIUnitsParts,
} from '../metrics';

describe('formatAsPercent', () => {
  it('formats with decimals by default', () => {
    expect(formatAsPercent(0.4567)).toBe('45.67%');
  });

  it('formats without decimals', () => {
    expect(formatAsPercent(0.4567, false)).toBe('46%');
  });

  it('handles zero', () => {
    expect(formatAsPercent(0)).toBe('0.00%');
  });

  it('handles 100%', () => {
    expect(formatAsPercent(1)).toBe('100.00%');
  });
});

describe('formatAsPercentParts', () => {
  it('returns value and unit parts', () => {
    expect(formatAsPercentParts(0.4567)).toEqual({ value: '45.67', unit: '%' });
  });

  it('returns parts without decimals', () => {
    expect(formatAsPercentParts(0.4567, false)).toEqual({ value: '46', unit: '%' });
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500, false)).toBe('500.00 B');
  });

  it('formats bytes per second', () => {
    expect(formatBytes(500, true)).toBe('500.00 B/s');
  });

  it('formats KiB', () => {
    expect(formatBytes(2048, false)).toBe('2.00 KiB');
  });

  it('formats KiB/s', () => {
    expect(formatBytes(2048, true)).toBe('2.00 KiB/s');
  });

  it('formats MiB', () => {
    expect(formatBytes(1024 * 1024 * 5, false)).toBe('5.00 MiB');
  });

  it('formats MiB/s', () => {
    expect(formatBytes(1024 * 1024 * 5, true)).toBe('5.00 MiB/s');
  });

  it('formats GiB', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 2, false)).toBe('2.00 GiB');
  });

  it('formats GiB/s', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 2, true)).toBe('2.00 GiB/s');
  });

  it('formats TiB', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024, false)).toBe('1.00 TiB');
  });

  it('formats TiB/s', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024, true)).toBe('1.00 TiB/s');
  });

  it('formats without decimals', () => {
    expect(formatBytes(1024 * 1024 * 5, true, false)).toBe('5 MiB/s');
  });
});

describe('formatBytesParts', () => {
  it('returns B parts', () => {
    expect(formatBytesParts(500, false)).toEqual({ value: '500.00', unit: 'B' });
  });

  it('returns B/s parts', () => {
    expect(formatBytesParts(500, true)).toEqual({ value: '500.00', unit: 'B/s' });
  });

  it('returns KiB parts', () => {
    expect(formatBytesParts(2048, false)).toEqual({ value: '2.00', unit: 'KiB' });
  });

  it('returns KiB/s parts', () => {
    expect(formatBytesParts(2048, true)).toEqual({ value: '2.00', unit: 'KiB/s' });
  });

  it('returns MiB parts', () => {
    expect(formatBytesParts(1024 * 1024 * 5, true)).toEqual({ value: '5.00', unit: 'MiB/s' });
  });

  it('returns GiB parts', () => {
    expect(formatBytesParts(1024 * 1024 * 1024 * 2, true)).toEqual({ value: '2.00', unit: 'GiB/s' });
  });

  it('returns TiB parts', () => {
    expect(formatBytesParts(1024 * 1024 * 1024 * 1024, true)).toEqual({ value: '1.00', unit: 'TiB/s' });
  });

  it('returns parts without decimals', () => {
    expect(formatBytesParts(2048, false, false)).toEqual({ value: '2', unit: 'KiB' });
  });
});

describe('formatBitsSIUnits', () => {
  it('formats bits per second', () => {
    expect(formatBitsSIUnits(500, true)).toBe('500.00 bps');
  });

  it('formats bits without per second', () => {
    expect(formatBitsSIUnits(500, false)).toBe('500.00 bp');
  });

  it('formats Kbps', () => {
    expect(formatBitsSIUnits(5000, true)).toBe('5.00 Kbps');
  });

  it('formats Kb', () => {
    expect(formatBitsSIUnits(5000, false)).toBe('5.00 Kb');
  });

  it('formats Mbps', () => {
    expect(formatBitsSIUnits(5_000_000, true)).toBe('5.00 Mbps');
  });

  it('formats Mb', () => {
    expect(formatBitsSIUnits(5_000_000, false)).toBe('5.00 Mb');
  });

  it('formats Gbps', () => {
    expect(formatBitsSIUnits(5_000_000_000, true)).toBe('5.00 Gbps');
  });

  it('formats Gb', () => {
    expect(formatBitsSIUnits(5_000_000_000, false)).toBe('5.00 Gb');
  });

  it('formats without decimals', () => {
    expect(formatBitsSIUnits(5000, true, false)).toBe('5 Kbps');
  });
});

describe('formatBitsSIUnitsParts', () => {
  it('returns bps parts', () => {
    expect(formatBitsSIUnitsParts(500, true)).toEqual({ value: '500.00', unit: 'bps' });
  });

  it('returns bp parts', () => {
    expect(formatBitsSIUnitsParts(500, false)).toEqual({ value: '500.00', unit: 'bp' });
  });

  it('returns Kbps parts', () => {
    expect(formatBitsSIUnitsParts(5000, true)).toEqual({ value: '5.00', unit: 'Kbps' });
  });

  it('returns Mbps parts', () => {
    expect(formatBitsSIUnitsParts(5_000_000, true)).toEqual({ value: '5.00', unit: 'Mbps' });
  });

  it('returns Gbps parts', () => {
    expect(formatBitsSIUnitsParts(5_000_000_000, true)).toEqual({ value: '5.00', unit: 'Gbps' });
  });

  it('returns parts without decimals', () => {
    expect(formatBitsSIUnitsParts(5000, true, false)).toEqual({ value: '5', unit: 'Kbps' });
  });
});
