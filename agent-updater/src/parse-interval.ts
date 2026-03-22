/** Parse a human-readable interval string like "6h", "30m", "10s" into milliseconds. */
export function parseInterval(value: string): number {
  const match = value.match(/^(\d+)(h|m|s)$/);
  if (!match) {
    throw new Error(`Invalid interval format: '${value}'. Expected format: 6h, 30m, 10s`);
  }

  const amount = Number(match[1]);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000,
  };

  return amount * multipliers[unit];
}
