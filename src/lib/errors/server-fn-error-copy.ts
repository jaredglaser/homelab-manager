export const DASHBOARD_UNREACHABLE_MESSAGE = "Couldn't reach the dashboard. Check your connection and try again.";

/** User copy for a rejected server-function call. Never returns the error's own text. */
export function serverFnErrorMessage(err: unknown, fallback: string): string {
  console.error(err);
  // Server throws arrive as a plain Error, so a TypeError here means the request failed in the browser.
  return err instanceof TypeError ? DASHBOARD_UNREACHABLE_MESSAGE : fallback;
}
