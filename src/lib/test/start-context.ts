import { runWithStartContext, type StartStorageContext } from '@tanstack/start-storage-context';
import { mockModule } from '@/lib/test/mock-module';
import type * as RoleMiddleware from '@/lib/auth/role-middleware';

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
  // runWithStartContext is sync-typed, so this Promise.resolve is load-bearing.
  return Promise.resolve(runWithStartContext(createTestStartContext(), fn));
}

type RoleCheck = (ctx: { context: unknown; next: () => unknown }) => unknown;

// A direct call runs only the client side of each middleware, so without this the real role check never fires in a unit test.
export function runRoleMiddlewareOnClientPath(): void {
  mockModule<typeof RoleMiddleware>('@/lib/auth/role-middleware', (real) => {
    // Read before the mock replaces the export, or the wrapper below calls itself.
    const realRoleMiddleware = real.roleMiddleware;
    return {
      ...real,
      roleMiddleware: (...allowed: Parameters<typeof realRoleMiddleware>) => {
        const check = realRoleMiddleware(...allowed).options.server as unknown as RoleCheck;
        return {
          options: {
            type: 'function',
            client: ({ next, sendContext }: { next: () => unknown; sendContext: unknown }) =>
              check({ context: sendContext, next: () => next() }),
          },
        };
      },
    };
  });
}
