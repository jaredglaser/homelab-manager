# Project Guidelines for Codex

This repo's shared operating rules live in [CLAUDE.md](CLAUDE.md). Treat that file as the canonical source for:

- workflow and verification requirements
- commands and local-dev routines
- architecture and data-flow notes
- project conventions, gotchas, and testing rules

Codex-specific notes:

- Repo-local Codex skills live under `.codex/skills/`.
- Those skills are versioned with the repo, but Codex only auto-discovers installed skills from `~/.codex/skills` (or `$CODEX_HOME/skills`).
- To install the repo-local skills as symlinks, run `.codex/scripts/install-repo-skills.sh`.
- `.claude/settings*.json`, `.claude/commands`, and `.claude/agents/` are Claude-specific references, not executable Codex config.

When `AGENTS.md` and `CLAUDE.md` overlap, keep the shared project rules in `CLAUDE.md` and keep this file as the Codex entry point.
