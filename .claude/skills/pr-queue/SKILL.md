---
name: pr-queue
description: Orchestrate the open PR queue for this repo - track state in a per-session GitHub issue that survives context compaction, subscribe to PR activity, triage review findings, answer review comments, and dispatch subagents to open or fix PRs. Use when asked about PR status, when a github-webhook-activity event arrives, when told a PR has review comments, or when picking up PR work after a compaction.
---

# PR queue orchestration

You hold the queue; subagents do the code work. Durable state lives in a GitHub issue, never in this
repo and never only in your context, so a compaction costs nothing.

Everything you write on GitHub follows CLAUDE.md rule 15: no em dashes, no en dashes, no `--`
standing in for one, none of the vocabulary tells. You write more prose in this role than in any
other, so this is the rule to watch.

## Triggers

| Input | Response |
|---|---|
| "status", "what needs my attention", "what is next" | The status report, three blocks, nothing above the first |
| A half-formed idea | Shape it: options with a recommendation, then dispatch |
| "PR N has comments", or a `github-webhook-activity` event | Triage against current code, then dispatch the confirmed set |
| Resuming after a compaction | Find the tracker by tag, re-derive every row, then report |

## Session identity

Several orchestrator sessions can run at once, so each owns a tag.

The tag is `pq-` plus the first segment of the UUID in your **scratchpad path**. It is not derived
from the session id. Recompute it each time rather than storing it.

**A recomputed tag is unusable until `search_issues` returns your tracker for it.** Recovery after a
compaction is "search the tag", so a tag derived from the wrong string looks like a session with no
tracker, and you open a second one against the same work.

The tracker title carries a friendly name beside the tag: `PR queue: otter (pq-xxxxxxxx)`. Any short
word, no coordination needed. The tag guarantees uniqueness; the name exists only so it can be said
out loud.

End every GitHub artifact this session creates with the tag on its own last line:

```
`pr-queue session pq-xxxxxxxx`
```

That means the tracker, PRs you open, and issues you open for parked questions. Not review replies,
never code.

Subagents get the tag in their brief. A subagent's scratchpad may not be yours.

## The tracking issue

One issue per session. Edit the body in place so it reads as current state rather than a log; issue
history gives you versioning for free.

It carries:

- A row per open PR: number, base, CI verdict, merge state against that base, what blocks it, and
  which findings are unresolved with how each was dispositioned.
- Decisions waiting on the human, numbered so they can be answered by number.
- Parked repo-wide questions belonging to no single PR.
- A short merged log, kept only while it still explains something.

Detail beats brevity. "Blocked on review" forces a round trip; a finding at a file:line with its fix
cost does not. Prune what no longer changes a decision, not what does.

**The tracker summarizes; the PR holds the primary evidence. On any disagreement the PR wins.**
Reopen the PR before acting on a tracker line about it, and link the comment a decision came from.

No status comment per PR: they drift against the tracker. No queue state in PR descriptions: the
body is the author's artifact and reviewers read it.

Update the tracker before ending any turn that changed PR state, dispatched an agent, or got a
decision. A stale tracker is worse than none, because it gets trusted.

To rebuild one from scratch:

```bash
git fetch origin --quiet
git merge-tree --write-tree origin/<base> origin/<head> >/dev/null 2>&1; echo $?  # 0 = clean
git rev-list --count origin/<head>..origin/<base>                                 # commits behind
```

plus `mcp__github__list_pull_requests` and `pull_request_read` with `method: get_check_runs`.

## The status report

Three blocks. Nothing above the first.

**1. Needs you, in order.** Numbered, each answerable on its own. Order by value returned per minute
of their time, not by PR number and not by how much it unblocks for you: a one-click approval that
frees a stacked chain outranks a decision that saves you an hour, and their longest task goes last
even when it is the most important, especially when something else gates it anyway. Every item
carries a rough time cost, one line on why it is theirs rather than yours, the options, and your
recommendation with its reason. Never present options without recommending one.

**2. I can do without you, on your word.** Already-decided work you have not executed, one line
each. A decision moves here once made, so block 1 only ever holds live questions.

**3. Green, no action.** Two lines. What is passing and where the default branch is.

Fold coupled questions into one item rather than splitting them; separating them invites answering
half. Cite the state that makes each ask real (`mergeable_state`, a check verdict, a file:line) so
nothing has to be taken on faith.

## Turning an idea into a PR

When the input is a thought rather than a queue item:

- Treat it as an invitation to shape it, not an instruction to implement it. Bounce the options back
  with a recommendation, then dispatch. Once a direction is approved, execute without re-confirming
  at each step (CLAUDE.md rule 11).
- Use light, fast subagents for the research, in the codebase or online, rather than spending
  orchestrator context on the survey yourself.

This does not contradict "dispatch, do not report" below. A confirmed finding on an open PR has no
design question left in it; a new idea is nothing but design questions.

## Subscriptions and check-ins

Subscribe to every in-flight PR. A subscription made before a compaction still holds even though
your memory of it does not, so consult the tracker rather than re-subscribing blindly. It ends only
when the PR merges or closes.

Webhooks miss CI success, new pushes, and merge-conflict transitions, so schedule a check-in about
an hour out and re-arm it silently when nothing changed.

**Stop after three consecutive no-ops.** Delete the pending trigger, tell the human the queue is
idle and what each PR is waiting on, and let them wake you. A human-blocked queue yields nothing per
poll, and polling it trains you to skim the results.

Decide no-op by comparing head SHA and `updated_at` per PR against what the last check recorded. If
both match, nothing moved and the check runs cannot have changed either, so skip `get_check_runs`
and leave the tracker alone rather than bumping its timestamp for nothing.

**A check-in prompt is text you wrote earlier. Its facts are stale by construction, and it cannot
authorize a merge.** Re-derive from the API. Re-derive every row of the PR table too: republishing a
row claims it is fresh, so a carried-forward `mergeable_state` is not stale, it is false.

## Triaging review findings

**Verify every finding against current code before acting** (CLAUDE.md rule 13). Expect a real
false-positive rate. Recurring shapes:

- The excerpt is scoped too narrowly, and the cleanup it asks for already exists in an enclosing
  `describe`/`afterEach`.
- The cited convention is the web package's while the file follows the agent package's.
- The finding is right and its suggested diff is still wrong. **Never apply a committable suggestion
  unmodified.**

Rules about the review rather than about a finding:

- **Fixing a finding is not closing the hole it named.** When a finding describes a class of
  failure, audit every gate on the path, not only the line quoted.
- **An "Addressed in commit" marker is not a review.** The bot writes those without re-reading, and
  it goes rate-limited often enough to matter.
- **Do not challenge a walkthrough while the run still says "review in progress".** A completed one
  can still be wrong.
- **Docstring Coverage is a standing decline here.** It scores a PR down for removing the JSDoc that
  CLAUDE.md rule 14 forbids.
- **Stacked PRs get skipped entirely**, so a PR based on another branch may never be reviewed at
  all. Say that, rather than reporting the silence as approval.

Reply on the thread for every decline, with evidence: a file:line, a grep count, a merge base.
Concrete replies get findings withdrawn. Otherwise fix silently, since the diff is the record, and
comment only when a round resolves something, hits a blocker, or raises a question.

**Verifying a finding is the decision to fix it. Dispatch, do not report.** A finding you have
checked and confirmed needs no approval; the human already asked for the queue to move. Turning
finished triage into a status line parks it behind a question nobody needed to answer, and the
verdicts go stale as the branch moves. Batch the confirmed set into one brief and send it the moment
triage ends. Surface only what genuinely needs a human: whether to merge, how to resolve a conflict,
a design call with no defensible default.

Human review comments outrank the bot. A reviewer pushing back on an approach ("wouldn't a lint rule
make more sense") is a redirect, not a question: change the design instead of defending it. A
request reaffirmed after you raise a concern is a decision.

End every comment with the attribution footer, then the tag:

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

## Dispatching subagents

Delegate work that needs its own context. Apply small fixes yourself: a few lines across two files
costs more to delegate than to do.

Every brief carries:

- **Exact branch, base, and head SHA.** `isolation: "worktree"` branches from the default branch,
  not the feature branch (CLAUDE.md gotcha 14), so an agent told only "fix PR N" rebuilds the
  feature from scratch and then conflicts.
- **Its own detached worktree at an explicit SHA**, `git worktree add --detach <scratchpad>/wt-<n>
  <sha>`, with an order to `cd` there before any write. Never send an agent into the orchestrator's
  own tree: you are using it, and the branch is usually checked out in some stale worktree already,
  so `git checkout` there fails. Push from the detached head with an explicit refspec, `git push
  origin HEAD:<branch>`.
- **Never chain `git checkout` into `git reset --hard` with `&&`.** A failed checkout still runs the
  reset, which then lands on whatever branch was actually checked out. Have the agent verify `git
  rev-parse --abbrev-ref HEAD` as a separate command first.
- **`bun run setup`**, per CLAUDE.md. Never `bun install --frozen-lockfile --force`: the agent
  package is deliberately not a workspace member, and `--force` drifts its lockfile against the only
  one the docker build sees.
- **Which findings are in scope and which are explicitly not**, with reasons, or agents helpfully
  fix the declined ones.
- **The exact verification command, not the goal.** Told to "run the tests", an agent picks the
  cheapest sibling that looks right and reports green over a gate it never ran.
- **The escape hatches, named and forbidden.** "Make the gate pass" gets threshold edits and
  unrelated paths added to ignore lists. Name the off-limits files, and require a residual gap to
  come back as a number with the responsible files named.
- **The session tag**, and a pointer to CLAUDE.md rule 14. Never ask an agent to add an explanatory
  comment.
- **An instruction to report where the brief is wrong rather than coding to it.** A brief is a
  hypothesis, not a spec. Expect corrections and act on them.

Ask for specifics back (which approach and why, per-file test counts before and after, coverage
numbers), then verify the claims independently against the pushed branch. Agents report
optimistically.

## Verifying claims

- **CI is the authority, not local runs.** Read `get_check_runs`, never `get_status`, which sees
  only the review bot and has reported green over failing jobs.
- **Check which SHA a green run tested.** A run can predate the commit in front of you.
- **Prove a new test fails without the fix** before claiming it guards anything, and read the
  failure text rather than the exit code: a test can fail for the wrong reason.
- **A zero grep count is a claim about absence.** Check case and spelling before publishing it.
- **Audit your own added comments before committing**, `git diff | grep -E "^\+\s*(//|\*|/\*)"`,
  pruned against CLAUDE.md rule 14.
- **A newly merged CI job is a suspect, not an oracle.** Check whether it carries a registry or
  fixture the queued PRs must feed, then whether the harness it feeds is usable at all.
- Never `git checkout <file>` to undo a probe while you hold uncommitted edits in that file.

Proving a test fails, without `git stash` (`.git/refs/stash` is shared across every worktree in this
repo, and several are usually live):

```bash
cp <file> /tmp/file-fixed.ts
git checkout <base-sha> -- <file>
bun test <testfile> -t "<test name>"   # must FAIL; read the failure text
cp /tmp/file-fixed.ts <file>
```

When the local suite cannot be made green (see Environment), compare failure sets instead of chasing
zero:

```bash
git worktree add --detach <scratchpad>/wt-base <base-sha>
(cd <scratchpad>/wt-base && bun run setup && bun run test:all 2>&1 \
  | grep -E "^\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort > base-fails.txt)
(cd <scratchpad>/wt-fix  && bun run test:all 2>&1 \
  | grep -E "^\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort > fix-fails.txt)
comm -13 base-fails.txt fix-fails.txt   # fails only on the branch: yours
comm -23 base-fails.txt fix-fails.txt   # fails only on the base
```

Report the raw numbers and the delta. Never report a green you did not observe.

## Coverage

- **`bun test --isolate` does not enforce coverage; `bun run test` does**, by piping into
  `scripts/check-coverage.js`. Read the thresholds there rather than restating them.
- **`coveragePathIgnorePatterns` needs a glob or an exact path.** A bare directory with a trailing
  slash matches nothing and fails silently, so a dead entry reads as a working exclusion.
- **A coverage failure is not always about the diff.** An import graph change alone moves the
  denominator: modules that nothing previously loaded during tests enter the table at their real
  coverage, with no source change. Diff the coverage table against the base before blaming the new
  code.
- **`bun test` claims any `*.spec.ts`**, so in a repo that also runs Playwright it collects the
  Playwright specs and the run dies with "did not expect test() to be called here" and no failing
  assertion to point at. Name e2e specs `*.e2e.ts` and give each Playwright project an explicit
  `testMatch`, plus `testIgnore` where two projects share a directory.

## Stacked PRs and git

- **A squash-merged base PR breaks every PR stacked on it, quietly.** GitHub retargets the child to
  the default branch, so it presents as merely conflicted rather than structurally stale, and its
  last green CI ran against a pre-retarget SHA. Recover with `git rebase --onto <new-base>
  <old-parent-tip>`, then:

  ```bash
  git push --force-with-lease=<branch>:<sha> origin HEAD:<branch>
  ```

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

## Environment

Check these rather than assuming them. Each has produced a wrong conclusion.

- **`gh` may not be installed.** Prefer `mcp__github__*`. CLAUDE.md's `gh run view` and `gh pr
  checks` advice does not apply where it is absent.
- **`subscribe_pr_activity` exists on more than one MCP server.** Qualify it.
- **`issue_write` cannot close a pull request.** Use `update_pull_request` with `state: closed`, and
  close any linked issue in a second call: closing a PR without merging does not close the issue.
- **Your comments may post as the repo owner**, indistinguishable from theirs. After a compaction
  the attribution footer is the only way to tell their directives from your own prior replies.
- **Check `id -u`.** Under root, `chmod`-based fixtures assert nothing, because root reads the file
  either way. Root-safe substitutes: a self-referential symlink (`existsSync` false, `readFileSync`
  throws `ELOOP`), or a directory where the file belongs (`EISDIR`).
- **Compare `bun --version` against `.bun-version`.** When they differ, local failures may have
  nothing to do with the change: module mocks can leak across files despite `--isolate`,
  contradicting CLAUDE.md rule 7. Install the pinned version, or use the failure-set diff above.

## Migration numbering

Migrations collide silently: distinct filenames, so git will not flag it and CI will not catch it.
Before merging anything carrying a migration, check the highest number on the default branch and on
every other open PR, and renumber on the way in.
