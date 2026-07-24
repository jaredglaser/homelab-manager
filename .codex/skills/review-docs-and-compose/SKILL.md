---
name: review-docs-and-compose
description: Audit this repo's documentation and Docker Compose files when the user asks for a docs audit, release-readiness check, or stale compose validation; verify docs against the codebase and verify compose files against docs, env vars, and Dockerfiles.
---

# Review Docs And Compose

Use this when documentation or compose files may be stale.

Start by reading `CLAUDE.md`, then inspect only the files relevant to the request.

## Primary targets

- `README.md`
- `self-hosting/README.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/dev-oidc.md`
- `docs/tech-stack.md`
- `docs/project-structure.md`
- `docs/git-stacks-repo.md`
- `CLAUDE.md`
- `AGENTS.md`
- `docker-compose.yml`
- `docker-compose.dev.yml`
- `docker-compose.local.yml`
- `docker-compose.agent.yml`
- `self-hosting/docker-compose.yml`
- `package.json`
- `.env.example`
- `Dockerfile`
- `agent/Dockerfile`

## Workflow

1. Fact-check concrete claims in docs against the codebase.
2. Identify gaps: undocumented services, env vars, commands, routes, tables, or operational behavior.
3. Validate compose files against `.env.example`, Dockerfiles, package scripts, and the docs.
4. Fix the highest-confidence issues directly when the user asked for remediation; otherwise report findings only.

## What to verify

- file paths, component names, and route names actually exist
- package scripts and commands match `package.json`
- documented env vars exist and match compose usage
- compose build targets exist in the Dockerfiles
- service names, ports, volumes, health checks, and network settings are internally consistent
- docs accurately describe local-dev vs self-hosting behavior

## Delegation

If the user explicitly asks for sub-agents or parallel review, split the work into independent read-only audits. Otherwise do the review yourself in a single pass.

## Output

For review-only requests, present findings first with file references and severity. If no issues are found, say that explicitly and mention any remaining validation gaps.
