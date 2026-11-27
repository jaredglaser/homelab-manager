---
name: plan-page
description: Publish one page that shows a planned change to the maintainer before any code is written, with the decisions, every message a user would see, the edge cases and the reach. His answers on the page become the acceptance criteria. Use before starting any change that has a design choice, user-visible text or more than one file.
---

# Plan page

Before writing code, give the maintainer one page he can decide from. He answers on the page, and his answers are the acceptance criteria. Nothing is added to it once the work starts: evidence stays in the PR and the records repo.

## Steps
1. Research without narrating. Read the code the change touches, and run the current app where today's behaviour matters. Do not post findings as you go.
2. Copy `template.html` from this folder to a scratch file. Its `window.PLAN` is a skeleton: one entry per list, with text that says what belongs there. Replace every value and the `<title>`. Leave everything else alone.
3. Publish it with the Artifact tool and `capabilities: {db: {}, user: {}}`.
4. Send one message: the link and the number of decisions. Nothing else.
5. When he says he is done, read his answers with `ArtifactData` (`get`, collection `reviews`, document id = the plan's `slug`). `criteria` holds the list. `open` must be 0. If it is not, ask about what is open and nothing else.
6. Copy `criteria` word for word into the PR body, or into `criteria/pr-<N>.md` when the `orchestrate` skill is in use. Then start.

## What goes in PLAN
- `picture`: where behaviour changes, today against proposed, in at most four rows. Say what a user sees, not which function runs.
- `decisions`: every choice that is his to make: design, scope, a new dependency, a new standing rule, anything that reaches code outside the change. Each option states what it changes, costs and locks in. Mark one `rec: true`. A choice you would otherwise make silently belongs here.
- `words`: every string the change would put in front of a user, as a draft, with what triggers it. All of them, not a sample. Follow `AGENTS.md#user-error-copy`. Add `doubt` where you are unsure.
- `edges`: each edge case, the behaviour you propose, and its proof type (`unit`, `e2e`, `stack`, `ci`, `run`). Include what must not change. Add `today` where you checked current behaviour.
- `reach`: what the change touches beyond itself, counted in the current code.
- `files`: existing files named from the code, new files as proposals.

## Rules
- "Today" is measured or read from the current code. Everything else is a proposal. Never present a prediction as a fact.
- Plain words. No function names in `picture`, `words` or `edges`.
- Leave a list empty to drop its section. A change with no user-visible text has no `words`.
- A trivial change (a typo, a comment, a dependency bump) needs no page.
