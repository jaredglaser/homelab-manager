# pr-queue reference

Detail that only matters once you are inside a task. SKILL.md carries the policy; this file carries
the recipes and the failure shapes behind it. Read the section you need when you get there.

## Ordering block 1 of the status report

Order by value returned per minute of the human's time, not by PR number and not by how much it
unblocks for you: a one-click approval that frees a stacked chain outranks a decision that saves you
an hour, and their longest task goes last even when it is the most important, especially when
something else gates it anyway.

## Turning an idea into a PR

When the input is a thought rather than a queue item, treat it as an invitation to shape it, not an
instruction to implement it: bounce the options back with a recommendation, then dispatch. Once a
direction is approved, execute without re-confirming at each step (CLAUDE.md rule 11). Send the
survey to `pr-research` rather than spending orchestrator context on it.

This does not contradict "dispatch, do not report" in SKILL.md. A confirmed finding on an open PR
has no design question left in it; a new idea is nothing but design questions.

## Bot false positives, recurring shapes

- The excerpt is scoped too narrowly, and the cleanup it asks for already exists in an enclosing
  `describe`/`afterEach`.
- The cited convention is the web package's while the file follows the agent package's.
- The finding is right and its suggested diff is still wrong. **Never apply a committable suggestion
  unmodified.**

## Rules about the review rather than about a finding

- **Fixing a finding is not closing the hole it named.** When a finding describes a class of
  failure, audit every gate on the path, not only the line quoted.
- **An "Addressed in commit" marker is not a review.** CodeRabbit writes those without re-reading,
  and it goes rate-limited often enough to matter.
- **Do not challenge a walkthrough while the run still says "review in progress".** A completed one
  can still be wrong.
- **Docstring Coverage is a standing decline here.** It scores a PR down for removing the JSDoc that
  CLAUDE.md rule 14 forbids.
- **CodeRabbit skips stacked PRs entirely**, so a PR based on another branch may never be reviewed
  at all. Say that, rather than reporting the silence as approval.

## Verifying claims

- **Check which SHA a green run tested.** A run can predate the commit in front of you.
- **Prove a new test fails without the fix** before claiming it guards anything, and read the
  failure text rather than the exit code: a test can fail for the wrong reason.
  `scripts/prove-test-fails.sh <base-sha> <file> <testfile> "<test name>"` does the swap and the
  restore, including the index entry that `git checkout <sha> -- <file>` leaves behind.
- **A zero grep count is a claim about absence.** Check case and spelling before publishing it.
- **Audit your own added comments before committing**, `git diff | grep -E "^\+\s*(//|\*|/\*)"`,
  pruned against CLAUDE.md rule 14.
- **A newly merged CI job is a suspect, not an oracle.** Check whether it carries a registry or
  fixture the queued PRs must feed, then whether the harness it feeds is usable at all.
- Never `git checkout <file>` to undo a probe while you hold uncommitted edits in that file, and
  never `git stash`: `.git/refs/stash` is shared across every worktree, and several are usually live.

When the local suite cannot be made green (CLAUDE.md gotcha 21 is the usual cause), compare failure
sets instead of chasing zero: `scripts/failure-set-diff.sh <base-sha> <fix-worktree>` builds the base
worktree, runs `test:all` in both, and prints the fails-only-on-branch and fails-only-on-base sets.
Report the raw numbers and the delta. Never report a green you did not observe.

## Git operations in a stack

The force-push auto-close hazard is in SKILL.md, not here, because it destroys work. These do not.

- **A squash-merged base PR breaks every PR stacked on it, quietly.** GitHub retargets the child to
  the default branch, so it presents as merely conflicted rather than structurally stale, and its
  last green CI ran against a pre-retarget SHA. `scripts/restack.sh <branch> <new-base>
  <old-parent-tip>` does the `rebase --onto` and the leased force-push behind the auto-close guard.
- **Check whether a commit is already upstream before asserting it must survive a replay**,
  `git merge-base --is-ancestor <commit> <cut-point>`. Forcing an ancestor through produces an empty
  commit.
- **Measure a stacked PR's real content from the merge base.** `git diff <sibling-a> <sibling-b>`
  reports the union of everything that differs, which is not what either PR contains. Find the merge
  base, then diff three-dot.
- **Byte identity is the strongest proof that a rebase preserved a sensitive area.** `git diff --stat
  <base-sha> <rebased-head> -- <path>` returning empty settles it with nothing left to read. Ask for
  that shape of evidence, not a narrative.
- **Recovering a corrupted branch.** Find the pre-damage SHA in `git reflog`; if the entry above the
  damage is a commit rather than a checkout, the tree was clean and nothing uncommitted was lost.
  Then `git worktree add --detach` at the correct parent, `git cherry-pick <sha>`, push. Never
  rebase in a tree holding staged changes. When the permission layer blocks `git reset --hard`, `git
  read-tree -u --reset HEAD` is the plumbing equivalent. If a stop hook demands committing a dirty
  tree, look at what the tree holds first.
