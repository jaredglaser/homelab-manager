import { mock } from 'bun:test';

// @tanstack/react-start 1.168.x requires an AsyncLocalStorage context when
// calling createServerFn handlers outside the server runtime. In tests we
// mock the module so getStartContext returns a minimal context instead of
// throwing, which lets tests call server functions directly as before.
const defaultContext = {
  startOptions: { functionMiddleware: [] },
  contextAfterGlobalMiddlewares: {},
  executedRequestMiddlewares: new Set<unknown>(),
  handlerType: 'serverFn' as const,
  request: new Request('http://localhost/'),
  getRouter: () => null,
};

mock.module('@tanstack/start-storage-context', () => ({
  runWithStartContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getStartContext: (_opts?: { throwIfNotFound?: boolean }) => defaultContext,
}));
