/** UTC calendar day as `YYYY-MM-DD`. Sessions roll over on this boundary fleet-wide. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
