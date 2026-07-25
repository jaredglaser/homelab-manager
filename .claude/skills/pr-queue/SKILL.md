---
name: pr-queue
description: Orchestrate the open PR queue for this repo - track state in a per-session GitHub issue that survives context compaction, subscribe to PR activity, triage CodeRabbit findings, answer review comments, and dispatch subagents to open or fix PRs. Use when asked about PR status, when a github-webhook-activity event arrives, when told a PR has review comments, or when picking up PR work after a compaction.
---

# PR queue orchestration

You are the orchestrator. You hold the queue; subagents do the code work. Your context should stay
small, so durable state lives on GitHub, not in your head and not in this repo.

## Session identity

Several orchestrator sessions can run at once, so each owns a tag and its own tracking issue.

The tag lives at `SESSION.md` in your scratchpad directory. Read it first. If it is missing, create
it: the tag is `pq-` plus the first segment of the session id (so it cannot collide with a
concurrent session), and the file records the tag and the tracking issue URL.

Every GitHub artifact this session produces ends with the tag on its own last line:

```
`pr-queue session pq-xxxxxxxx`
```

That means the tracking issue, any PR this session opens, and any issue opened for a parked
question. Not ordinary review replies, and never code comments. The whole session then resolves
with `repo:<owner>/<repo> pq-xxxxxxxx`.

Pass the tag inline in every subagent brief, not just via the file — an agent that reads the brief
and not the file still needs to tag correctly.

## State lives in one tracking issue, not in the repo

One GitHub issue per session, titled `PR queue — pq-xxxxxxxx`, whose body you **edit in place** so
it reads as current state rather than a log. Issue edit history gives you versioning for free.

It carries everything, because it is the only place state lives:

- **A row per open PR**: number, base, CI verdict, merge state against that base, and enough detail
  to act without opening the PR — what is blocking it, which findings are unresolved and how each
  was dispositioned, what is needed from the human on that PR specifically.
- Decisions waiting on the human, numbered so they can be answered by number.
- Parked repo-wide questions that belong to no single PR.
- A short merged log, kept only while it still explains something.

Detail beats brevity here. A row that says "blocked on review" forces a round trip; a row that says
which finding, at which file:line, and what the fix costs does not. Prune what no longer changes a
decision rather than trimming what does.

Do not open a status comment per PR — the tracker is the single view, and per-PR comments drift
against it. Do not put queue state in PR descriptions either: the body is the author's artifact, it
feeds templates, and reviewers read it.

Keep a scratchpad mirror if you like, but treat the issue as the source of truth: it is the copy
that survives container reclaim. **Update it before ending any turn that changed PR state,
dispatched an agent, or got a decision.** A stale tracker is worse than none, because it gets
trusted.

Rebuild from scratch when the tracker is gone — do not guess:

```bash
git fetch origin --quiet
git merge-tree --write-tree origin/<base> origin/<head> >/dev/null 2>&1; echo $?   # 0 = clean
git rev-list --count origin/<head>..origin/<base>                                   # commits behind
```

plus `mcp__github__list_pull_requests` and `pull_request_read` with `method: get_check_runs`.

## Subscriptions

Stay subscribed to every in-flight PR via `subscribe_pr_activity`. A subscription made before a
compaction still holds even though your memory of it does not, so consult the tracker rather than
re-subscribing blindly.

A subscription ends only when the PR merges or closes. Webhooks miss CI success, new pushes and
merge-conflict transitions, so schedule a `send_later` check-in about an hour out and re-arm it
silently when nothing changed.

## Triaging CodeRabbit

**Verify every finding against current code before acting** (CLAUDE.md rule 13). The false-positive
rate is real: of 8 findings on #368, 3 were wrong or out of scope. Recurring shapes:

- The excerpt is scoped too narrowly — the cleanup it asks for exists in an enclosing
  `describe`/`afterEach`.
- The cited convention is the web package's and the agent package follows a different one.
- The finding is right and the suggested diff is still wrong. On #368 the `readUntil` deadline fix
  hoisted the timer out of the loop but left `clearTimeout` inside it, which would have disabled the
  timeout entirely. **Never apply a committable suggestion unmodified.**

Reply on the thread for every decline, with evidence: a file:line, a grep count, a merge base.
CodeRabbit withdraws findings when the reply is concrete. Fix silently — the diff is the record —
and comment only when a round resolves something, hits a blocker, or raises a question.

Every GitHub comment you author ends with the attribution footer, then the session tag:

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

## Human review comments

These outrank CodeRabbit. When the reviewer pushes back on an approach ("surely an abstraction for
this already exists", "wouldn't a lint rule make more sense"), that is a redirect, not a question:
change the design instead of defending the current one. A request reaffirmed after you raise a
concern is a decision — proceed with the full request.

## Dispatching subagents

Delegate work that needs its own context; apply small fixes yourself. A few lines across two files
is not worth an agent, and delegating it costs more than it saves.

Every brief carries:

- **Exact branch, base, and head SHA.** `isolation: "worktree"` branches from **main**, not the
  feature branch (CLAUDE.md gotcha 14). An agent told only "fix PR #N" rebuilds the feature from
  scratch and then conflicts.
- **`bun install --frozen-lockfile --force`.** Plain `bun run setup` drifts the lockfile under bun
  1.3.x and produces phantom typecheck failures in `src/lib/test/start-context.ts`.
- **Which findings are in scope and which are explicitly not**, with reasons. Otherwise agents
  helpfully fix the declined ones.
- **Verification before reporting**: `bun run typecheck:all`, the relevant test/coverage script,
  and the push result.
- **The session tag**, and a pointer to CLAUDE.md rule 14 on comments. Never ask an agent to "add
  an explanatory comment".

Ask for specifics back (which approach and why, per-file test counts before and after, coverage
numbers), then verify the claims independently against the pushed branch. Agents report
optimistically.

## Verification discipline

- **CI is the authority, not local runs.** Local `bun test` failures are usually drifted
  `node_modules`; check `get_check_runs` first. Equally, read `get_check_runs` and never
  `get_status` — `get_status` shows only CodeRabbit and has reported green over two failing jobs.
- **Check which SHA a green run tested.** A run can predate the commit you are looking at.
- **Prove a new test fails without the fix** before claiming it guards anything.
- Never `git checkout <file>` to undo a probe while you hold uncommitted edits in that file.

## Migration numbering

Migrations collide silently: distinct filenames, so git will not flag it and CI will not catch it.
Before merging anything carrying a migration, check the highest number on main and on every other
open PR, and renumber on the way in.
