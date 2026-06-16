import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * Override the result of a server function for a test, layered on top of the
 * shared MSW mocks. The function name is the `createServerFn` export (e.g.
 * `listStacks`); `result` replaces what the mock would return (an empty list, an
 * error-shaped value, an alternate session, ...).
 *
 * This is the "modify requests" half of the harness. It cannot use `page.route`:
 * MSW's service worker answers `/_serverFn` before the request reaches
 * Playwright's network layer. Instead it seeds `window.__mockServerFnOverrides`,
 * which the MSW handler (running in the page) reads. Must be called before
 * `page.goto` so the override is present for the first call (e.g. the session
 * check on load).
 */
export async function overrideServerFn(
  page: Page,
  functionName: string,
  result: unknown,
): Promise<void> {
  await page.addInitScript(
    ([name, value]) => {
      const w = window as typeof window & {
        __mockServerFnOverrides?: Record<string, unknown>;
      };
      w.__mockServerFnOverrides = w.__mockServerFnOverrides ?? {};
      w.__mockServerFnOverrides[name as string] = value;
    },
    [functionName, result] as const,
  );
}

/**
 * Assert that the text rendered within `target` changes within `timeoutMs`,
 * proving SSE updates reach the DOM. The stats streams push a fresh snapshot
 * about every second, so a live page mutates while a static fixture would not;
 * this is the end-to-end signal that EventSource plus the table merge live data,
 * which a unit test with a frozen fixture cannot show.
 */
export async function expectLiveTextUpdate(
  target: Locator,
  timeoutMs = 8000,
): Promise<void> {
  const first = await target.innerText();
  await expect
    .poll(async () => (await target.innerText()) !== first, { timeout: timeoutMs })
    .toBe(true);
}

export const test = base;
export { expect };
