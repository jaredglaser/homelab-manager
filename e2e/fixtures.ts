import { test as base } from '@playwright/test';

/**
 * Shared entry point for e2e specs. Per-scenario response overrides
 * (`overrideServerFn`) arrive with the deep-flow tests that use them.
 */
export const test = base;
export { expect } from '@playwright/test';
