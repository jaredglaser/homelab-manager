# Import Protection (TanStack Start)

Static imports are safe in `createServerFn` modules. Issue #251.

## Verdict

Import protection works on the installed version (`@tanstack/react-start`
1.168.27) and static imports are safe in `createServerFn` modules. The
conversion in `src/data/git-tokens.functions.tsx` is kept. The dynamic-import
rule still applies to SSE route handlers (`src/routes/api/`), see
"What is NOT covered" below.

## How it works

- **Import protection plugin**: configured in `vite.config.ts` as
  `tanstackStart({ importProtection: { behavior: 'error' } })`. The plugin is
  on by default, but its default behavior is `mock` in dev and `error` only at
  build time; setting `behavior: 'error'` makes a violation fail in both.
- **Marker modules**: `import '@tanstack/react-start/server-only'` marks a
  file server-only. Any import of a marked file from the client graph fails
  the build with a full import trace. Marked entry points:
  `src/lib/clients/database-client.ts`, `src/lib/config/database-config.ts`,
  `src/lib/crypto/master-key.ts`, `src/lib/crypto/encrypted-value.ts`,
  `src/lib/database/repositories/git-token-repository.ts`.
- **Server function compiler**: replaces `.handler(fn)` bodies with RPC stubs
  in the client build and runs dead code elimination, removing top-level
  imports that only handler bodies referenced. This is what makes static
  imports safe in server function modules.

## Trial conversion

`src/data/git-tokens.functions.tsx` was converted from `await import()` inside
each handler to static top-level imports (`node:crypto`, database client,
config, master keyring, encrypted-value, git token repository). Every
server-only module it reaches statically carries the marker, so a dead-code
elimination regression fails the build instead of shipping pg to the browser.

### Verification

- `bun run build` passes; client assets contain no server-only module identifiers.
- `bun run build:demo` passes. `src/components/settings/AuthManagementCard.tsx`
  imports `@/data/git-tokens.functions` directly and that barrel is not
  demo-aliased, so the client graph genuinely reaches the marked modules in
  both builds.
- Existing tests pass unchanged.
- Negative test: adding a static import of `database-client` (and separately of
  `master-key`) to `AuthManagementCard.tsx` fails `bun run build` with
  `[import-protection] Import denied in client environment`, the offending
  source line, and the full trace from `src/router.tsx` down to the marker.

## What is NOT covered

SSE route files (`src/routes/api/*`) define handlers inside
`createFileRoute({ server: { handlers: ... } })`. Those handler closures are
part of the route module, and route modules are in the client bundle. A static
top-level import of a server-only module from a route file would land in the
client graph. The `await import()` pattern inside `loadSubscribe` callbacks
stays mandatory for SSE routes.

## Converting more modules

For `createServerFn` modules (not SSE routes):

1. Move `await import()` calls to static top-level imports.
2. If the module pulls in a new server-only entry point that lacks protection,
   add `import '@tanstack/react-start/server-only'` to that entry point.
3. Run `bun run build` and grep `.output/public/assets` for identifiers from
   the server-only modules.
4. Keep test `mock.module()` registrations before the import of the module
   under test (the existing test layout already does this).

Skip modules that the demo build aliases (`@/data/docker/functions`,
`@/data/zfs/functions`, `@/data/proxmox/functions`, `@/data/settings/functions`,
`@/data/stacks/functions`, `@/data/auth.functions`; see `buildAliases()` in
`vite.config.ts`) unless the mock counterpart is checked against
`bun run build:demo` as well.
