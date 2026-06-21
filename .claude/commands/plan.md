---
description: Plan a task on Opus, then dispatch implementation to model-tiered agents
argument-hint: [what you want built]
model: opus
---

You are the planning orchestrator for this task: **$ARGUMENTS**

Run on Opus (this command pins the planning turn to Opus). Work in two phases.

## Phase 1 — Plan (you, on Opus)

1. Research the codebase enough to plan accurately. Use the `Explore` or
   `Plan` subagents for broad read-only fan-out so you don't burn this
   context on file dumps.
2. Produce an implementation plan broken into discrete, independently
   dispatchable tasks. For each task specify:
   - the exact files it touches,
   - a one-line statement of the change,
   - its **complexity tier**: `trivial` or `standard` (rubric below),
   - dependencies on other tasks (what must land first).
3. Present the plan for approval via plan mode (ExitPlanMode). Do not start
   editing until it is approved.

### Complexity rubric

- **trivial** -> `haiku-implementer`: single-file, mechanical, no design
  decisions. Renames, constants, copy/doc tweaks, a straightforward test
  addition, mechanical find-and-replace.
- **standard** -> `sonnet-implementer`: multi-file, real logic, debugging,
  refactors with design judgment, or anything touching server functions, SSE,
  the worker, the agent, or auth/crypto.
- When unsure, round up to `standard`. A misrouted trivial task wastes one
  cheap call; a misrouted standard task produces a wrong change.

## Phase 2 — Dispatch (after approval)

For each task, call the `Agent` tool with the subagent that matches its tier
(`haiku-implementer` or `sonnet-implementer`). In the prompt give the agent the
full context it needs: the files to touch, the exact change, and any
constraints, because the subagent does not share this conversation's context.

- Run independent tasks **in parallel** (multiple Agent calls in one message).
- Run dependent tasks in order; feed the relevant result of an upstream task
  into the downstream task's prompt.
- If a `haiku-implementer` reports a task was bigger than expected, re-dispatch
  it to `sonnet-implementer`.

## After all tasks land (you, the orchestrator)

1. Run `bun run typecheck:all` and `bun run test:all` and confirm they pass
   (CLAUDE.md end-of-task workflow). Fix or re-dispatch any failures.
2. Check whether `README.md` / `CLAUDE.md` need updates.
3. You own git. Commit on the current feature branch with a clear message and
   push only when the user asks. Do not open a PR unless asked.

Subagents must not commit or push; version control stays with you.
