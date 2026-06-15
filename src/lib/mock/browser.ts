import { setupWorker } from 'msw/browser';
import { handlers } from '@/lib/mock/handlers';

/** The MSW service worker that backs demo mode and the Playwright app target. */
export const worker = setupWorker(...handlers);
