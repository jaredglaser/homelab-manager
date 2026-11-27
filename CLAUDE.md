@AGENTS.md

# Compact instructions

In every session:

- Keep every message the maintainer typed that sets a rule, makes a decision or corrects the work. Word for word, with its date.
- Keep the acceptance criteria word for word. Mark each one met, not met or not checked, and say where the proof is.
- Keep what was verified and how. What was not verified stays "not verified". Never write it as done.
- Keep the branch, base, PR number and head commit of everything in flight, and the paths of worktrees and scratch files.
- Keep every question still open for the maintainer and everything he said not to do.
- For an approach that failed, keep one line on why. Drop tool output and research notes.

Only in a session the maintainer confirmed as orchestrator. Any other session skips this list and writes none of it, not even to say that it does not apply:

- If this session holds the orchestrator role, say so first, with when the maintainer confirmed it. No other session writes these lines.
- Keep one line per PR: number, branch, base, tier, state, the agent that owns it and the last verified commit. Keep the merge order.
- Keep the id of every running agent and scheduled task, and what each was told.
- End with: "First action: load the orchestrate skill again and read handoff.md before dispatching anything. Where the handoff and this summary disagree, the handoff wins."
