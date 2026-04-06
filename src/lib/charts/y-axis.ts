/** Nice intervals to choose from (scaled by magnitude) */
const NICE_INTERVALS = [1, 2, 5, 10, 20, 25, 50, 100];
const TARGET_TICKS = 5;

export interface YAxisConfig {
  max: number;
  interval: number;
}

/** Unit thresholds for byte-unit-aware scaling */
interface ByteUnit {
  threshold: number;
  divisor: number;
}

const BYTE_UNITS: ByteUnit[] = [
  { threshold: 1, divisor: 1 },
  { threshold: 1024, divisor: 1024 },
  { threshold: 1024 * 1024, divisor: 1024 * 1024 },
  { threshold: 1024 * 1024 * 1024, divisor: 1024 * 1024 * 1024 },
];

/** SI bit units (1000-based) for network throughput displayed as bps/Kbps/Mbps/Gbps */
const BIT_UNITS: ByteUnit[] = [
  { threshold: 1, divisor: 1 },
  { threshold: 1000, divisor: 1000 },
  { threshold: 1000 * 1000, divisor: 1000 * 1000 },
  { threshold: 1000 * 1000 * 1000, divisor: 1000 * 1000 * 1000 },
];

/**
 * Find a "nice" interval that gives approximately TARGET_TICKS ticks.
 */
export function findNiceInterval(range: number): number {
  const roughInterval = range / TARGET_TICKS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughInterval)));
  const normalized = roughInterval / magnitude;

  for (const nice of NICE_INTERVALS) {
    if (nice >= normalized) {
      return nice * magnitude;
    }
  }

  return magnitude * 10;
}

export type YAxisMode = 'linear' | 'percent' | 'bytes' | 'bits';

/**
 * Calculate clean y-axis max and interval values.
 *
 * Modes:
 * - 'linear': plain numeric scaling (default)
 * - 'percent': caps at 100, adds 10% headroom below 100
 * - 'bytes': works in byte-unit space for cleaner tick labels (KiB, MiB, GiB boundaries)
 */
export function calculateCleanYAxis(
  maxValue: number,
  mode: YAxisMode = 'linear',
): YAxisConfig {
  if (maxValue <= 0) {
    return { max: 100, interval: 20 };
  }

  if (mode === 'percent' && maxValue <= 100) {
    const effectiveMax = Math.min(maxValue * 1.1, 100);
    const interval = findNiceInterval(effectiveMax);
    const max = Math.min(Math.ceil(effectiveMax / interval) * interval, 100);
    return { max, interval };
  }

  if (mode === 'bits') {
    // maxValue is in bits; use SI (1000-based) unit boundaries for clean bps/Kbps/Mbps/Gbps ticks.
    let unit = BIT_UNITS[0];
    for (let i = BIT_UNITS.length - 1; i >= 0; i--) {
      if (maxValue >= BIT_UNITS[i].threshold) {
        unit = BIT_UNITS[i];
        break;
      }
    }
    const valueInUnit = maxValue / unit.divisor;
    const intervalInUnit = findNiceInterval(valueInUnit);
    const cleanMax = Math.ceil(valueInUnit / intervalInUnit) * intervalInUnit * unit.divisor;
    return {
      max: cleanMax,
      interval: intervalInUnit * unit.divisor,
    };
  }

  if (mode === 'bytes') {
    let unit = BYTE_UNITS[0];
    for (let i = BYTE_UNITS.length - 1; i >= 0; i--) {
      if (maxValue >= BYTE_UNITS[i].threshold) {
        unit = BYTE_UNITS[i];
        break;
      }
    }
    const valueInUnit = maxValue / unit.divisor;
    const intervalInUnit = findNiceInterval(valueInUnit);
    const cleanMax = Math.ceil(valueInUnit / intervalInUnit) * intervalInUnit;
    return {
      max: cleanMax * unit.divisor,
      interval: intervalInUnit * unit.divisor,
    };
  }

  // Linear mode
  const interval = findNiceInterval(maxValue);
  const max = Math.ceil(maxValue / interval) * interval;
  return { max, interval };
}
