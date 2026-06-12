# Import Protection (TanStack Start)

Evaluation of TanStack Start's import protection against the repo-wide rule
that server-only modules must load via `await import()` inside handlers
(CLAUDE.md rule 4). Tracked in issue #251.

## Verdict

Import protection works on the installed version (`@tanstack/react-start`
1.167.16) and static imports are safe in `createServerFn` modules. The trial
conversion in `src/data/git-tokens.functions.tsx` is kept. The dynamic-import
rule still applies to SSE route handlers (`src/routes/api/`), see
"What is NOT covered" below.

## What the installed version supports

Verified directly in `node_modules/@tanstack/start-plugin-core` at 1.167.16:

- **Import protection plugin**: enabled by default. Build behavior defaults to
  `error` (fails the build), dev behavior defaults to `mock`. Configurable via
  the `importProtection` option of `tanstackStart()` in `vite.config.ts`.
- **Default client rules**: deny `**/*.server.*` files and the
  `@tanstack/react-start/server` specifier in the client environment.
- **Marker modules**: a side-effect import of
  `@tanstack/react-start/server-only` marks the importing file server-only.
  Importing a marked file anywhere in the client module graph fails the build
  with a full import trace. The marker resolves to a virtual empty module in
  Vite and to a real empty module under plain Bun (worker, tests), so it is
  inert at runtime.
- **Server function compiler**: in the client environment the compiler
  replaces `.handler(fn)` bodies with RPC stubs (`/_serverFn/` fetch) and runs
  dead code elimination, which removes top-level imports that only handler
  bodies referenced. This is what makes static imports safe in server function
  modules.

## Trial conversion

`src/data/git-tokens.functions.tsx` was converted from `await import()` inside
each handler to static top-level imports (`crypto`, database client, config,
master keyring, encrypted-value, git token repository).

`src/lib/clients/database-client.ts` (the pg entry point) got the
`@tanstack/react-start/server-only` marker so any future accidental static
import from client code fails the build immediately instead of breaking at
runtime with `node:async_hooks` errors.

### Verification

- `bun run build` passes. Client assets in `.output/public/assets` contain no
  `pg`, `GitTokenRepository`, `databaseConnectionManager`, `loadMasterKeyring`,
  or `randomBytes(32)` references. The settings chunk calls the git token
  functions through RPC stubs only.
- The only `async_hooks` match in client assets is Monaco's TypeScript worker,
  which embeds the TS compiler's list of node builtin module names as a string
  literal. It is not an import and predates this change.
- Negative test: adding `import '@/lib/clients/database-client'` to a client
  component makes the build fail with
  `[import-protection] Import denied in client environment`, including the
  exact import chain from `src/router.tsx` down to the marker.
- `bun run build:demo` passes (the trial module is not demo-aliased; the
  marker module resolves the same way in both builds).
- `bun test --isolate src/data/__tests__/git-tokens.functions.test.ts` passes
  unchanged: `mock.module()` calls registered before the dynamic import of the
  module under test also intercept its static imports.

## What is NOT covered

SSE route files (`src/routes/api/*`) define handlers inside
`createFileRoute({ server: { handlers: ... } })`. Those handler closures are
part of the route module, and route modules are in the client bundle. A static
top-level import of a server-only module from a route file would land in the
client graph (and, with the marker, fail the build). The dynamic
`await import()` pattern inside `loadSubscribe` callbacks therefore stays
mandatory for SSE routes.

## Converting more modules

For `createServerFn` modules (not SSE routes):

1. Move the `await import()` calls to static top-level imports.
2. If the module pulls in a new server-only entry point that lacks protection,
   add `import '@tanstack/react-start/server-only'` to that entry point (the
   pg client already has it).
3. Run `bun run build` and grep `.output/public/assets` for identifiers from
   the server-only modules.
4. Keep test `mock.module()` registrations before the import of the module
   under test (the existing test layout already does this).

Skip modules that the demo build aliases (`docker`, `zfs`, `proxmox`,
`settings`, `stacks` function barrels) unless the mock counterpart is checked
against `bun run build:demo` as well.
