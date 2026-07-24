import { runWithStartContext, type StartStorageContext } from '@tanstack/start-storage-context';

// createServerFn middleware resolves startOptions through AsyncLocalStorage and throws when
// no Start context exists, so calling a server function directly in a unit test needs one.
function createTestStartContext(): StartStorageContext {
  return {
    getRouter: () => {
      throw new Error('getRouter is not available in unit tests');
    },
    request: new Request('http://localhost/'),
    startOptions: {},
    contextAfterGlobalMiddlewares: {},
    executedRequestMiddlewares: new Set(),
    handlerType: 'serverFn',
  };
}

export function withStartContext<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithStartContext(createTestStartContext(), fn);
}
