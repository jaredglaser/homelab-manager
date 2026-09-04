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
- SSE endpoints should respect `request.signal` and avoid leaking server-only imports into the client bundle.
- Dynamic imports are required for server-only modules such as `pg`, `dockerode`, `ssh2`, subscription services, and database clients in the sensitive paths called out by `AGENTS.md`.
- Docker or entity operations should use validated host-prefixed IDs, not display names.

## Search patterns

Use targeted searches such as:

- SQL construction in `client.query(...)`
- console logging around `password`, `token`, `secret`, or `key`
- static imports of `pg`, `dockerode`, or `ssh2` in route or mixed client/server code
- user input flowing into commands, file paths, or privileged agent operations

## Output

Report findings with:

- severity
- file and line
- risk
- concrete remediation

If no issues are found, say so explicitly rather than inventing findings.
