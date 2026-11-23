export const DASHBOARD_UNREACHABLE_MESSAGE = "Couldn't reach the dashboard. Check your connection and try again.";

/** User copy for a rejected server-function call. Never returns the error's own text. */
export function serverFnErrorMessage(err: unknown, fallback: string): string {
  console.error(err);
  // Start rebuilds every server-side throw as a plain Error, so a TypeError can only be fetch's own network failure.
  return err instanceof TypeError ? DASHBOARD_UNREACHABLE_MESSAGE : fallback;
}
