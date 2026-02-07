/**
 * Abbreviates a unit string to a compact form.
 * Examples: "MiB/s" → "M/s", "Kbps" → "K/s", "GiB" → "G"
 */
export function abbreviateUnit(unit: string): string {
  const abbreviations: Record<string, string> = {
    // Percent
    '%': '%',
    // Bytes (binary) with /s
    'B/s': 'B/s',
    'KiB/s': 'K/s',
    'MiB/s': 'M/s',
    'GiB/s': 'G/s',
    'TiB/s': 'T/s',
    // Bytes (binary) without /s
    'B': 'B',
    'KiB': 'K',
    'MiB': 'M',
    'GiB': 'G',
    'TiB': 'T',
    // Bits (SI) - convert bps style to /s style
    'bps': 'b/s',
    'Kbps': 'K/s',
    'Mbps': 'M/s',
    'Gbps': 'G/s',
  };
  return abbreviations[unit] ?? unit;
}
