import { serverFunctionHandlers } from '@/lib/mock/handlers/server-functions';
import { wsHandlers } from '@/lib/mock/handlers/ws';

/**
 * The full MSW handler set shared by demo mode (browser service worker) and the
 * Playwright app target.
 */
export const handlers = [...serverFunctionHandlers, ...wsHandlers];
