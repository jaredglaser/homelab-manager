/**
 * Format a number as a percentage with 2 decimal places
 * @param value - The percentage value (0-100)
 * @returns Formatted string (e.g., "45.67%")
 */
export function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

/**
 * Format disk IO as megabytes per second with 2 decimal places
 * @param value - The MB/s value
 * @returns Formatted string (e.g., "125.50 MB/s")
 */
export function formatMBps(value: number): string {
  return `${value.toFixed(2)} MB/s`;
}

/**
 * Format network speed as megabits per second with 2 decimal places
 * Converts to Gbps for values >= 1000
 * @param value - The Mbps value
 * @returns Formatted string (e.g., "125.50 Mbps" or "1.25 Gbps")
 */
export function formatMbps(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} Gbps`;
  }
  return `${value.toFixed(2)} Mbps`;
}
