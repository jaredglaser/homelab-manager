#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo_skills_dir="$repo_root/.codex/skills"
codex_home="${CODEX_HOME:-$HOME/.codex}"
target_dir="$codex_home/skills"

mkdir -p "$target_dir"

for skill_path in "$repo_skills_dir"/*; do
  [ -d "$skill_path" ] || continue

  skill_name="$(basename "$skill_path")"
  target_path="$target_dir/$skill_name"

  if [ -L "$target_path" ]; then
    existing_target="$(readlink "$target_path")"
    if [ "$existing_target" != "$skill_path" ]; then
      echo "Skipping $skill_name: $target_path already points to $existing_target" >&2
      continue
    fi
    rm "$target_path"
  elif [ -e "$target_path" ]; then
    echo "Skipping $skill_name: $target_path already exists and is not a symlink" >&2
    continue
  fi

  ln -s "$skill_path" "$target_path"
  echo "Linked $skill_name -> $target_path"
done
