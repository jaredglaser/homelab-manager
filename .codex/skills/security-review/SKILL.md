---
name: security-review
description: Review this homelab-management codebase for security issues when the user asks for a security review, sensitive-code audit, or credential-handling check; focus on secrets exposure, SQL injection, unsafe Docker or SSH usage, server-only import leaks, and missing validation.
---

# Security Review

Use this when the user asks for a security-oriented code review.

Start with `AGENTS.md`, then inspect the requested files or the relevant recent diff.

## Focus areas

1. Credential and secret exposure
2. SQL injection
3. SSH and Docker socket safety
4. Server-side auth, abort handling, and server-only import leaks
5. Input validation and path safety
6. Timing and information leaks

## Repo-specific checks

- Only `VITE_*` env vars should be client-visible.
- `createServerFn()` paths should use the expected middleware and validation.
- The `/api/mux` WebSocket route must use dynamic imports inside its handler callbacks. Static imports there leak server-only modules (`pg`, `dockerode`, subscription services, database clients) into the client bundle.
- In `createServerFn` modules, static imports are safe: the Start compiler strips handler bodies from the client bundle and `importProtection` fails the build on leaks (see `AGENTS.md` rule 4).
- Docker or entity operations should use validated host-prefixed IDs, not display names.

## Search patterns

Use targeted searches such as:

- SQL construction in `client.query(...)`
- console logging around `password`, `token`, `secret`, or `key`
- static imports of `pg`, `dockerode`, or subscription/database services in route or mixed client/server code
- user input flowing into commands, file paths, or privileged agent operations

## Output

Report findings with:

- severity
- file and line
- risk
- concrete remediation

If no issues are found, say so explicitly rather than inventing findings.
