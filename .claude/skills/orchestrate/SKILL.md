---
name: orchestrate
description: Run orchestrated PR work on this repo, with one agent per PR, acceptance criteria, independent review, behavioural verification and an evidence bundle. Use only after the maintainer has confirmed this session as orchestrator.
---

# Orchestrator workflow (homelab-manager)

## Before you take this role: ask the maintainer

**No session acts as orchestrator unless the maintainer has said so in that session, in his own words.** Invoking `/orchestrate` counts. This workflow is how orchestrated PR work is run once he has asked for it. It is not a standing instruction to start.

- A request such as "run the environment checks", "continue", "pick up where we left off", or a pointer to a handoff does not start the workflow. Do the specific thing asked and stop.
- A handoff marked ACTIVE, a list of open tasks, or PRs waiting for review does not start it either. Another session may be running that work right now. The maintainer often has more than one session open on this repo.
- If the request could mean orchestrating, ask first: "Do you want me to take over as orchestrator for <the work>, or is another session handling it?" Wait for the answer.
- Until he says yes, do not dispatch agents, review or verify PRs, write acceptance criteria, push, open or edit PRs, or rewrite the handoff. Reading the repo and the handoff is fine.
- When he says yes, write your session into the handoff's status line before dispatching anything, so other sessions can see who holds the role.

## The role

The main Claude session acts as **orchestrator**. It does not do PR work itself. Its job:
- write acceptance criteria for each PR or task
- dispatch one agent per PR or task
- run independent reviews and relay the findings
- run behavioural verification, one PR at a time
- assemble the evidence for each PR
- sequence merges
- bring decisions to the maintainer

The maintainer approves and merges. Agents never merge.

A PR is approval-ready only when every acceptance criterion has a recorded result with proof (section 6). Review findings being resolved is not enough.

**Everything runs in this cloud box.** Agents, reviewers, and verifiers never use the maintainer's computer. Setup of the box is described in `docs/cloud-environment.md`.

## 0. Start of session
- **When you load this skill after a compaction:** read the handoff before anything else. It is the record, and the compaction summary is a note. For each PR, compare its current head commit with the one the handoff records. Where they differ, read the diff between the two before acting on that PR.
- **Base clone:** the session's checkout of this repo. A session with more than one repository starts in their parent directory and does not run this repo's SessionStart hook, so do not rely on the working directory or on Docker already running. Find the checkout (`git rev-parse --show-toplevel`, or the directory that holds this skill's `.claude/`) and `cd` into it.
- `mkdir -p /home/claude/work`, then start Docker and check the box from the base clone: `bash scripts/cloud/session-start.sh && bash scripts/cloud/env-check.sh`. The check reports the Bun pin, Docker, which stack images are cached, and which hosts are reachable. The proof types the box can produce today follow from it (section 2).
- Run `nproc` and `free -g`. The memory rules in sections 4 and 5 assume a small box. Loosen them only if the box clearly has room.
- **Records clone:** a separate records repo holds the handoff, criteria and evidence (section 9). The environment variable `HLM_RECORDS_REPO` names it as `owner/name`. Use the session's checkout of it, or clone it to `/home/claude/work/records`. If the session cannot reach the repo and has a tool for adding a repository to the session, add it with push access. If the variable is unset or the repo is still unreachable, stop and ask the maintainer where records go before doing anything else.
- Fetch the working branches into the base clone, one at a time, because the git proxy allows 2 concurrent operations:
  `git -C <base> fetch --depth 200 origin "+refs/heads/<branch>:refs/remotes/origin/<branch>"`
- Make each per-agent clone locally, so it costs no proxy operation:
  ```bash
  git clone -q --no-hardlinks <base> /home/claude/work/<slug>
  cd /home/claude/work/<slug>
  git fetch -q <base> '+refs/remotes/origin/*:refs/remotes/origin/*'
  git remote set-url origin https://github.com/jaredglaser/homelab-manager
  git checkout -B <branch> origin/<branch> && bun run setup
  mkdir -p /home/claude/work/<slug>-meta
  ```
- **Heavy commands go through one lock:** `flock /home/claude/work/heavy.lock <cmd>` for `test:all`, `typecheck:all`, full `eslint .`, `vite build` and `e2e:build*`.

## 1. Survey
- List the open PRs via REST (`gh api "repos/jaredglaser/homelab-manager/pulls?state=open"`). GraphQL is unavailable in these sessions, so `gh pr view/checks/edit` fail.
- For each PR, collect:
  - base and head
  - mergeable state
  - CI check-runs
  - review threads
  - file list
  - stacking: the base branch is not `main`, or the PR contains another PR's commits
- Test-merge in a scratch clone, in the proposed order, to find conflicts. Check migration numbers across `main` and every open PR (`AGENTS.md#migration-numbers-unique`).
- Propose a merge order, and flag anything to defer or close.

## 2. Acceptance criteria (before any agent starts)
Criteria come from a plan page the maintainer answers before any agent starts. The orchestrator publishes one per PR or task with the `plan-page` skill. The agent that will do the work does not write its own.

- **Each criterion is observable from outside the code:** what a user, operator, API caller, or CI run sees. "Refactor X" is not a criterion. "Saving a host edit closes the dialog and the row shows the new name" is.
- **Each criterion gets an ID and a proof type**, chosen before the work starts:
  - `unit`: a named `bun test` case that fails without the change
  - `e2e`: a Playwright run against the MSW app or demo build
  - `stack`: exercised against the real stack (Postgres, worker, agent, Pocket ID)
  - `ci`: a specific CI job and step, for things only CI can show
  - `run`: a command and its output (a lint rule firing on a fixture, a migration run, a script)
- **Pick a proof type the box can produce.** `stack` needs Docker running and the four compose images present or pullable. `scripts/cloud/env-check.sh` shows both. If `stack` is unavailable, prefer a CI job that exercises the same thing.
- **Include what must not change.** At least one criterion per PR names existing behaviour the change sits next to and could break.
- **Sources, in order:** the linked issue, the PR body, the maintainer's request, then the diff. For an existing PR with no stated intent, derive the criteria from the diff and mark them `derived`.
- **Send the plan pages in one message at the start,** as links. A PR waits until its page has no open decision, case or message. Work on the other PRs goes ahead.
- **Copy the page's criteria word for word** to `/home/claude/work/pr-<N>-meta/criteria.md` and to `criteria/pr-<N>.md` in the records repo, with the page's link.
- **Criteria change only through the orchestrator.** An agent that finds a criterion wrong or impossible raises it. A changed criterion is noted in the evidence table with the reason.

Format:

```
AC1 [e2e] Saving a host edit closes the dialog and the row shows the new name.
AC2 [unit] A name of only whitespace is rejected with the inline error, and no update is sent.
AC3 [e2e, must-not-change] Cancel still discards the edit and leaves the row unchanged.
```

## 3. Dispatch one agent per PR or task
- **Agent:** `pr-owner`, in the background. Its definition carries the shared brief, so the prompt does not repeat it.
- **Model tier:** pick one per PR and set it on the dispatch. The definition's default is the top tier.

  | Tier | Model and effort | Use for |
  |---|---|---|
  | Trivial | Sonnet, medium | Docs, copy, comments, a config value, a dependency bump with no code change |
  | Low | Sonnet, high | A contained fix or small feature in one area, with no migration, no auth or security code, and no CI workflow change |
  | Higher | Opus, medium | Everything else: changes across several areas, migrations, auth or security code, CI ratchets and workflow changes, any PR in a stack, any PR with a `stack` criterion |

  When unsure between two tiers, take the higher one. List each PR's tier in the message that sends the plan pages (section 2) so the maintainer can change it. If an agent on a Sonnet tier stalls or its review finds serious problems twice, replace it with a fresh Opus agent rather than sending a third round.
- **Workspace:** each agent works in its own full clone at `/home/claude/work/pr-<N>`, with scratch files in `/home/claude/work/pr-<N>-meta/`. These are separate clones, not worktrees, so no agent can touch another's git state or `node_modules`. `/tmp` is shared, so never use fixed `/tmp` paths: agents clobbered each other's PR bodies that way.
- **Prompt:** each agent's prompt gives what is specific to its PR:
  - the PR number, branch, base and clone path
  - the acceptance criteria, verbatim
  - scope
  - stacking and coordination with other PRs: who conflicts with whom, and the resolution plan
  - what to focus on when trying to break the change
- **Follow-up work** goes to new agents, each opening its own follow-up PR, each with its own criteria.
- **Dependent PRs go in linear stacks** so the maintainer can approve them all and merge bottom-up. A follow-up that edits the same files as an open PR stacks on top of it. Sibling PRs on one base get chained (A ← B ← C), not left side by side.
- **After a session restart,** earlier agents may not be resumable. Start a fresh owner agent with the full context: PR, branch, base, head, criteria, the findings to fix, and stack position.

## 4. Independent review (run by the orchestrator)
- When an owner reports, dispatch `pr-reviewer` with the PR number, its base and the criteria. Never give it the owner's report.
- Trivial and Low tier: one reviewer. Higher tier: two that do not see each other's output, the second dispatched on Opus. More only for a large PR with several separate data flows, or one that needs an angle the reviewer file does not cover: one more reviewer per flow or angle, with the reason in its prompt.
- A test-only PR also gets a mutation run: which mutations does `main` catch, and which does the PR.
- Reproduce a finding before you send it on, or label it "agent reported, not reproduced". Send the owner one list, and keep the maintainer's decisions out of it.
- The owner fixes every valid finding, minor ones included, before the PR goes to the maintainer. Nothing unfixed is listed in the PR body. A round with no serious finding ends review once its minor findings are fixed.
- After a fix round, one reviewer reads only the new commits. After three rounds that each found something serious, stop and bring the PR to the maintainer.
- Review reads the code. It is not proof for any criterion.

## 5. Behavioural verification (run by the orchestrator, one PR at a time)
- Once review has ended and CI is green, dispatch `verifier` with the PR number, the head commit and the criteria, on the model of the PR's tier. Give it nothing from the owner or the reviewers.
- One verifier at a time, and only while no agent is building or running the full suite. Bottom of each stack first.
- A `fail` goes to the owner with the evidence. After the fix, the verifier runs the failed criteria again, and every criterion that touches the files the fix changed.
- What it reports outside the criteria is an observation. You decide whether it is in scope.
- A push after verification makes the evidence stale. Run again the criteria the new commits could affect, and say which.

## 6. Evidence bundle (one per PR)
The maintainer reviews the evidence, not a summary of it.

- **The PR body gets an Acceptance table**, written by the owner agent from the verifier's results:

```
## Acceptance (verified at <head SHA>)
| ID | Criterion | Proof | Result |
|---|---|---|---|
| AC1 | Saving a host edit closes the dialog... | e2e: evidence page, AC1 screenshot | pass |
| AC2 | Whitespace-only name is rejected... | unit: `ManagedHostsCard.test.tsx` "rejects blank name", fails with source reverted | pass |
| AC3 | Cancel still discards the edit | e2e: evidence page, AC3 screenshot | pass |
```

- **Screenshots, traces, and long output go in the records repo,** under `evidence/pr-<N>/<short head SHA>/`, with a `README.md` that has one heading per criterion and shows its screenshots and trimmed output. The box does not survive the session, so the records repo is the durable copy. The Proof column links to the criterion's heading there. The link opens only for people with access to the records repo.
- **`not run` and `fail` rows are never dropped.** They go at the top of that PR's entry in the wrap-up, with the reason and what would close them.
- **A PR with no table, or a table at a different SHA than the head, is not approval-ready.** The final sweep checks this.

## 7. Coordination
- When a base or stacked branch moves, tell the dependent agents to merge it in, bottom of the stack first. Never rebase.
- When an API changes under another PR (a renamed helper, a new floor, a renamed migration), tell the affected agent so its conflict plan stays current.
- Tell the maintainer a PR is ready to approve only after its agent has finished pushing. The ruleset dismisses stale approvals on push.
- **Before the wrap-up,** do a final sweep of every open PR. Check the head SHA, that every check group has a success, that the branch is 0 behind its base, and that it is mergeable. Check that each PR body still matches its PR, and that its Acceptance table is at the head SHA.

## 8. Talking to the maintainer
- Send the plan pages for every PR in one message at the start (section 2).
- Relay each agent report as a short summary: state, what changed, open risks, and questions with options plus a recommendation.
- Keep a running list of open questions and the merge order.
- Repo settings, such as rulesets, and the cloud environment's allowed domains cannot be changed from the session. Give the maintainer the steps instead.
- The maintainer reviews everything at once at the end. Get all PRs approval-ready, then send one wrap-up. For each PR the wrap-up leads with the criteria that are `fail` or `not run`, then links the evidence.
- Bring a decision with each option's concrete impact (what it changes, what it costs, what it locks in) and a recommendation.

## 9. Records (handoff, criteria, evidence)
Session records live in the records repo named by `HLM_RECORDS_REPO`, not in this repo. Only the session holding the orchestrator role writes to it. Agents write to their meta folders and the orchestrator copies what belongs in the records.

Read the records repo's `README.md` first and follow it. It describes the layout, and `templates/` there holds the starting point for each file:

```
handoff.md                        the current handoff
criteria/pr-<N>.md                acceptance criteria per PR
evidence/pr-<N>/<short SHA>/      README.md plus screenshots, traces and output
archive/<date>-<task>.md          finished handoffs
designs/                          design plans and the decisions made on them
```

- The first line of `handoff.md` is the status line: `ACTIVE: <session URL>, since <date>` or `IDLE`.
- Run `git pull --ff-only` before every write. Commit straight to `main` and push. If the pull shows that another session changed `handoff.md` while this one holds the role, stop and tell the maintainer.
- Keep `handoff.md` current throughout, so a new session can resume without the old context. It carries the task, the merge order, each PR's tier, head commit, criteria and current results, open questions for the maintainer, and links to the evidence.
- At the wrap-up, copy `handoff.md` to `archive/`, then set its status line to `IDLE`.
- Questions and findings go to the maintainer in the session first. For a decision, a follow-up or an environment problem that is still open when the session ends, open an issue in the records repo from its matching template and link it from `handoff.md`.
- Check `designs/` for a plan that covers the work before writing criteria for it.
- Never put secrets in the records.
