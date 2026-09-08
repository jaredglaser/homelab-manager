---
name: pr-fix-findings
description: Apply a batch of already-confirmed review findings to a PR branch, verify, and push. Use after triage has confirmed which findings are real. Not for deciding whether a finding is valid; use pr-triage for that, and pr-rebase when the branch needs a new base rather than a code change.
---

You apply a batch of findings that have **already been confirmed**, then verify and push. Triage is
done; do not re-litigate it, and do not fix findings the dispatch declined. The dispatch names both
sets and its reasons. Agents that helpfully fix the declined ones create a second review round.

## Working rules

- Work in the **detached worktree at the explicit SHA the dispatch names**. `cd` there before any
  file write and use relative paths from there. Never touch the orchestrator's tree.
- **Never chain `git checkout` into `git reset --hard`**, with any separator. `&&` short-circuits, so
  it is the safer of the two; `;` runs the reset even after the checkout fails, so switching to it
  makes this strictly worse. The hazard `&&` does not catch is a checkout that exits 0 while landing
  somewhere you did not mean: `git checkout foo` DWIM-creates a local branch tracking `origin/foo`,
  and `git checkout origin/foo` detaches HEAD. A chained reset then moves a ref you never targeted.
  Run `git rev-parse HEAD` as its own command and read the output before any reset.
- **Never `git stash`.** `.git/refs/stash` is shared across every worktree in this repo and dozens
  are live.
- Install with **`bun run setup`**. Never `bun install --force` or `--frozen-lockfile`: the agent
  package is not a workspace member and `--force` drifts its lockfile against the one the docker
  build uses.
- Push from the detached head with an explicit refspec: `git push origin HEAD:<branch>`.

## Applying a finding

- **Never apply a bot's committable suggestion unmodified.** A finding can be right while its
  suggested diff is wrong.
- **Fixing a finding is not closing the hole it named.** When a finding describes a class of
  failure, check every site on that path, not only the quoted line.
- Verify the finding still describes the current code before you touch it. Branches move.

## Verifying

- Run **the exact command the dispatch names**, not a cheaper sibling. `bun run test` enforces
  coverage; `bun test --isolate` does not, so a green `--isolate` run says nothing about the gate.
- **Never edit `scripts/check-coverage.js`, `bunfig.toml`, `sonar-project.properties`, or any file
  under `.github/workflows/`** to make a gate pass, and never add unrelated paths to an ignore list.
  A residual gap comes back as a number with the responsible files named.
- If you add a test, prove it fails without the fix before claiming it guards anything, and read the
  failure text rather than the exit code:
  `.claude/skills/pr-queue/scripts/prove-test-fails.sh <base-sha> <file> <testfile> "<test name>"`.
- When the suite cannot be made green at all, compare failure sets instead of chasing zero:
  `.claude/skills/pr-queue/scripts/failure-set-diff.sh <base-sha> <your-worktree>`.

## Reporting

- AGENTS.md rule 14: no explanatory comments in the code, including "to explain the change". If the
  change needs explaining, that belongs in the commit message. Rule 15 governs the prose you write:
  no em dashes, en dashes, `--` as a dash, or the vocabulary tells.
- Audit your own diff before committing: `git diff | grep -E "^\+\s*(//|\*|/\*)"`, pruned against
  rule 14.
- Report **where the dispatching brief is wrong** rather than coding to it. If a finding does not
  reproduce, say so and skip it. Do not invent a change to satisfy a stale description.
- Report per-finding: what you changed, the file:line, and the verification output you actually
  observed. Give per-file test counts before and after when the dispatch asks. Never report a green
  you did not see.
