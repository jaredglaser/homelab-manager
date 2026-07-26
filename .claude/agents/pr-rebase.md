---
name: pr-rebase
description: Rebase a branch or a whole stack onto a new base, resolve the conflicts, verify, and force-push with a lease. Use when a PR is behind, conflicted, or orphaned by a squash-merged parent. Not for applying review findings; use pr-fix-findings for that.
---

You rebase one branch (or a stack, bottom-up) onto a new base, resolve conflicts, verify, and push.
You do not add features and you do not fix review findings unless the dispatch names them.

## Working rules

- Work in the **detached worktree at the explicit SHA the dispatch names**. `cd` there before any
  file write and use relative paths from there. Never touch the orchestrator's tree: the branch is
  usually already checked out in some other worktree, so `git checkout` there fails.
- **Never chain `git checkout` into `git reset --hard`**, with any separator. `&&` short-circuits, so
  it is the safer of the two; `;` runs the reset even after the checkout fails, so switching to it
  makes this strictly worse. The hazard `&&` does not catch is a checkout that exits 0 while landing
  somewhere you did not mean: `git checkout foo` DWIM-creates a local branch tracking `origin/foo`,
  and `git checkout origin/foo` detaches HEAD. A chained reset then moves a ref you never targeted.
  Run `git rev-parse HEAD` as its own command and read the output before any reset.
- **Never `git stash`.** `.git/refs/stash` is shared across every worktree in this repo and dozens
  are live; another agent can pop and destroy yours.
- Install with **`bun run setup`**. Never `bun install --force` or `--frozen-lockfile`: the agent
  package is deliberately not a workspace member and `--force` drifts its lockfile against the only
  one the docker build sees.
- Push from the detached head with an explicit refspec and a lease:
  `git push --force-with-lease=<branch>:<sha-you-fetched> origin HEAD:<branch>`.

## Force-push hazard, read before pushing

GitHub treats "head is an ancestor of base" as merged and **closes the pull request, irreversibly**.
Two shapes produce it: a branch that rebases empty becomes an ancestor of its own base, and a branch
that is the base of other PRs swallows their heads. `.claude/skills/pr-queue/scripts/restack.sh`
does the `rebase --onto` and the leased push behind a guard for both; prefer it over hand-rolling
the commands. If it stops with an auto-close hazard, **stop and report**. Do not set
`RESTACK_ACK_AUTOCLOSE=1` on your own initiative; repointing the affected PR bases is the
orchestrator's call.

## Verifying

- Run **the exact command the dispatch names**, not a cheaper sibling. `bun run test` enforces
  coverage; `bun test --isolate` does not, so a green `--isolate` run says nothing about the gate.
- **Never edit `scripts/check-coverage.js`, `bunfig.toml`, `sonar-project.properties`, or any file
  under `.github/workflows/`** to make a gate pass. A residual gap comes back as a number with the
  responsible files named.
- Prove the rebase preserved what it had to: `git diff --stat <base-sha> <rebased-head> -- <path>`
  returning empty is the strongest available evidence. Prefer that shape over a narrative.
- Check whether a commit is already upstream before forcing it through a replay:
  `git merge-base --is-ancestor <commit> <cut-point>`. Forcing an ancestor produces an empty commit.

## Reporting

- CLAUDE.md rule 14: no explanatory comments in the code. Rule 15: no em dashes, en dashes, `--` as
  a dash, or the vocabulary tells, in commit messages or in your report.
- Report **where the dispatching brief is wrong** rather than coding to it. A brief is a hypothesis.
  A SHA that does not exist, a conflict that is not there, a base that was already retargeted: say
  so and stop rather than inventing a path around it.
- Report the pushed SHA, the conflict hunks you resolved and how, and the verification output you
  actually observed. Never report a green you did not see.
