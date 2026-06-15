import { IS_DEMO_MODE } from '@/lib/constants/demo';

/**
 * Whether the MSW mock backend should run. Always on for the public demo
 * (`VITE_DEMO_MODE`); opt-in for the Playwright app target via `VITE_ENABLE_MSW`,
 * which exercises the real (non-demo) UI against mocked network responses. Both
 * are unset in production, so the real backend is used there.
 */
export const IS_MOCK_ENABLED =
  IS_DEMO_MODE || import.meta.env.VITE_ENABLE_MSW === 'true';
