import { test as base, expect, type Locator, type Page } from '@playwright/test';

import { registeredServerFnNames } from '@/lib/mock/handlers/server-functions';

/**
 * Override the result of a server function for a test, layered on top of the
 * shared MSW mocks. The function name is the `createServerFn` export (e.g.
 * `listStacks`); `result` replaces what the mock would return (an empty list, an
 * alternate session, ...).
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
  if (!registeredServerFnNames.includes(functionName)) {
    throw new Error(
      `overrideServerFn: "${functionName}" is not a mocked server function. Known names: ${registeredServerFnNames.join(', ')}`,
    );
  }
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
 * A single change is also produced by the page settling after load, so two are
 * required: only the second one rules out a stream that sent one frame and died.
 * `target` must be the narrowest locator carrying streamed values, since a
 * page-wide one is satisfied by unrelated chrome.
 */
export async function expectLiveTextUpdate(
  target: Locator,
  timeoutMs = 8000,
): Promise<void> {
  let previous = await target.innerText();
  for (let change = 0; change < 2; change++) {
    await expect
      .poll(async () => (await target.innerText()) !== previous, { timeout: timeoutMs })
      .toBe(true);
    previous = await target.innerText();
  }
}

export const test = base;
export { expect };
