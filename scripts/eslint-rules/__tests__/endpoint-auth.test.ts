import { describe, it, expect } from 'bun:test';
import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { endpointAuthRule } from '../endpoint-auth.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

const serverFnFile = '/repo/src/data/stacks/functions.tsx';
const routeFile = '/repo/server/routes/api/thing.ts';

ruleTester.run('endpoint-auth', endpointAuthRule, {
  valid: [
    {
      name: 'roleMiddleware after authMiddleware',
      filename: serverFnFile,
      code: `
        export const scanDrift = createServerFn()
          .middleware([authMiddleware, roleMiddleware('admin', 'operator')])
          .handler(async () => scan());
      `,
    },
    {
      name: 'a read open to every signed-in role, with another middleware after the role check',
      filename: serverFnFile,
      code: `
        export const listStacks = createServerFn()
          .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware])
          .validator(schema)
          .handler(async () => list());
      `,
    },
    {
      name: 'roleMiddleware in a later .middleware call',
      filename: serverFnFile,
      code: `
        export const fn = createServerFn()
          .middleware([authMiddleware])
          .middleware([roleMiddleware('admin')])
          .handler(async () => null);
      `,
    },
    {
      name: 'a route that authenticates the request',
      filename: routeFile,
      code: `export default handler(async (event) => { await authenticateRequest(event); });`,
    },
  ],
  invalid: [
    {
      name: 'roleMiddleware missing',
      filename: serverFnFile,
      code: `
        export const scanDrift = createServerFn()
          .middleware([authMiddleware])
          .handler(async () => scan());
      `,
      errors: [{ messageId: 'fnMissingRole' }],
    },
    {
      name: 'roles checked inside the handler instead of the chain',
      filename: serverFnFile,
      code: `
        export const scanDrift = createServerFn()
          .middleware([authMiddleware, databaseMiddleware])
          .handler(async ({ context }) => { requireRole('admin')(context.user); });
      `,
      errors: [{ messageId: 'fnMissingRole' }],
    },
    {
      name: 'roleMiddleware before authMiddleware',
      filename: serverFnFile,
      code: `
        export const scanDrift = createServerFn()
          .middleware([roleMiddleware('admin', 'operator'), authMiddleware])
          .handler(async () => scan());
      `,
      errors: [{ messageId: 'fnRoleBeforeAuth' }],
    },
    {
      name: 'roleMiddleware without authMiddleware',
      filename: serverFnFile,
      code: `
        export const scanDrift = createServerFn()
          .middleware([roleMiddleware('admin')])
          .handler(async () => scan());
      `,
      errors: [{ messageId: 'fnMissingAuth' }],
    },
    {
      name: 'no middleware at all',
      filename: serverFnFile,
      code: `export const scanDrift = createServerFn().handler(async () => scan());`,
      errors: [{ messageId: 'fnMissingAuth' }],
    },
    {
      name: 'a route with no auth enforcement',
      filename: routeFile,
      code: `export default handler(async (event) => resolveUserFromCookie(event));`,
      errors: [{ messageId: 'routeMissingAuth' }],
    },
  ],
});

describe('endpoint-auth inline disable', () => {
  const linter = new Linter({ configType: 'flat', cwd: '/repo' });
  const config = [
    {
      files: ['**/*.tsx'],
      languageOptions: { parser: tseslint.parser },
      plugins: { local: { rules: { 'endpoint-auth': endpointAuthRule } } },
      rules: { 'local/endpoint-auth': 'error' },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
  ] as Linter.Config[];

  const getSession = (directive: string) => `
    // Unauthenticated by design: session bootstrap, callable without an existing session.
    ${directive}
    export const getSession = createServerFn()
      .middleware([sessionReadMiddleware])
      .handler(async ({ context }) => context.sessionUser);
  `;

  it('accepts a deliberately signed-out function that disables the rule with its reason', () => {
    const messages = linter.verify(getSession('// eslint-disable-next-line local/endpoint-auth'), config, serverFnFile);
    expect(messages).toEqual([]);
  });

  it('reports the same function without the disable', () => {
    const messages = linter.verify(getSession(''), config, serverFnFile);
    expect(messages.map((message) => message.messageId)).toEqual(['fnMissingAuth']);
  });
});
