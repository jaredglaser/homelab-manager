# Import Protection (TanStack Start)

Static imports are safe in `createServerFn` modules. Issue #251.

## Verdict

Import protection works on the installed version (`@tanstack/react-start`
1.167.16) and static imports are safe in `createServerFn` modules. The
conversion in `src/data/git-tokens.functions.tsx` is kept. The dynamic-import
rule still applies to SSE route handlers (`src/routes/api/`), see
"What is NOT covered" below.

## How it works

- **Import protection plugin**: enabled by default; the build fails if a
  server-only module is imported from the client environment.
- **Marker modules**: `import '@tanstack/react-start/server-only'` marks a
  file server-only. Any import of a marked file from the client graph fails
  the build with a full import trace.
- **Server function compiler**: replaces `.handler(fn)` bodies with RPC stubs
  in the client build and runs dead code elimination, removing top-level
  imports that only handler bodies referenced. This is what makes static
  imports safe in server function modules.

## Trial conversion

`src/data/git-tokens.functions.tsx` was converted from `await import()` inside
each handler to static top-level imports (`crypto`, database client, config,
master keyring, encrypted-value, git token repository).

`src/lib/clients/database-client.ts` (the pg entry point) got the
`@tanstack/react-start/server-only` marker so any accidental static import
from client code fails the build instead of breaking at runtime with
`node:async_hooks` errors.

### Verification

- `bun run build` passes; client assets contain no server-only module identifiers.
- `bun run build:demo` passes.
- Existing tests pass unchanged.
- Negative test: importing `database-client` from a client component fails with
  `[import-protection] Import denied in client environment` and the exact
  import chain.

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
   add `import '@tanstack/react-start/server-only'` to that entry point (the
   pg client already has it).
3. Run `bun run build` and grep `.output/public/assets` for identifiers from
   the server-only modules.
4. Keep test `mock.module()` registrations before the import of the module
   under test (the existing test layout already does this).

Skip modules that the demo build aliases (`docker`, `zfs`, `proxmox`,
`settings`, `stacks` function barrels) unless the mock counterpart is checked
against `bun run build:demo` as well.
