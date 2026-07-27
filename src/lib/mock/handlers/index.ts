import { serverFunctionHandlers } from '@/lib/mock/handlers/server-functions';
import { sseHandlers } from '@/lib/mock/handlers/sse';

/**
 * The full MSW handler set shared by demo mode (browser service worker) and the
 * Playwright app target. SSE handlers come first so their streaming responses win
 * over any broad server-function matcher.
 */
export const handlers = [...sseHandlers, ...serverFunctionHandlers];
