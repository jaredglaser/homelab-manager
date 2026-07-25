## What and why

<!-- One or two sentences. What changes, and what problem it solves. Link the issue if there is one. -->

## Flow

<!-- The path through the system, not a list of files. Where does this sit, and what moves through it?
Arrows are good:

  AgentStatsCollector -> docker_stats -> StatsPollService -> /api/docker-stats -> useTimeSeriesStream
  git push -> post-receive -> DeployRequest -> resolve secrets -> agent -> deploy_history

If the path already exists and you are changing it, show before and after. If it is new, show the whole
thing. For work with no runtime path (CI, tooling, docs) describe what triggers it and what it gates. -->

## What else this touches

<!-- Other callers of anything whose signature or behavior changed. Migrations, and whether the number
collides. Anything reading the same table, SSE channel, or settings key. Anything gated on an env var or
event type. "Nothing outside <x>" is a good answer when it is true; say it rather than leaving this empty. -->

## Verification

<!-- What you ran and what it showed, not what should pass. `bun run typecheck:all` and `bun run test:all`
at minimum for code changes. Coverage differs between local and CI because some tests skip in CI, so cite
the CI result for anything coverage-related. Note manual steps separately if a real host was involved. -->
