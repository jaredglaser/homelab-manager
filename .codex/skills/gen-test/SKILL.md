---
name: gen-test
description: Generate or extend tests for this repo when the user asks for test coverage on a source file, hook, component, or server module; follow the repo's bun:test, co-located __tests__, and anti-global-mock conventions.
---

# Generate Tests

Use this when the user wants tests added or expanded.

Before editing:

1. Read `AGENTS.md` for testing rules and coverage constraints.
2. Read the source file and any existing co-located test file in `__tests__/`.
3. Prefer extending an existing test file over creating a new pattern for the same module.

## Required conventions

- Use `bun:test`, not Jest or Vitest.
- Put tests in a co-located `__tests__/` directory.
- Use `@/` imports for shared `src` modules. Tests co-located in `__tests__/` may import the module under test with a relative path; helpers inside the same test area may also use relative imports.
- Prefer dependency injection, `renderHook`, `spyOn`, and narrow mocks.
- Do not use `mock.module()` on React, broad shared modules, or `functions.tsx` barrels.
- When mocking a service module, provide every exported member (use stubs or pass-throughs for exports the current test does not exercise) so concurrent tests do not see `undefined` exports.
- Cover exported behavior, edge cases, and error paths.
- Remember PostgreSQL `BIGINT` values arrive as strings.

## Verification

After editing, run the narrowest useful test command first, then broader verification if needed:

1. `bun test <test-file>`
2. `bun test --coverage <test-file>` when the task is focused on coverage for that module
3. Repo-level verification required by `AGENTS.md` after code changes

If you cannot run the commands, say so clearly and explain why.
