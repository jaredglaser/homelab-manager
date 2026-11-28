#!/bin/bash
# The repo hook runs this in every Claude Code session, so it must do nothing outside a cloud box.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0

REPO="${HLM_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TOOLS="${HLM_TOOLS_DIR:-$HOME/.hlm-tools}"
DOCKERD_LOG="${HLM_DOCKERD_LOG:-/tmp/dockerd.log}"
DOCKER_RUN_DIR="${HLM_DOCKER_RUN_DIR:-/var/run}"
# Below the hook's 120 second limit, so a cut-short install still leaves time to print the status line.
BUDGET_MS="${HLM_START_BUDGET_MS:-100000}"
DOCKER_WAIT_MS="${HLM_DOCKER_WAIT_MS:-30000}"
PIN="$(cat "$REPO/.bun-version")"

# The hook adds stdout to the session's context, so only the status line may reach it.
exec 3>&1 >"${HLM_START_LOG:-/tmp/hlm-session-start.log}" 2>&1

now_ms() { date +%s%3N; }
DEADLINE=$(( $(now_ms) + BUDGET_MS ))
bounded() {
  local ms=$(( DEADLINE - $(now_ms) ))
  [ "$ms" -gt 0 ] || return 124
  timeout -k 2 "$(printf '%d.%03d' $(( ms / 1000 )) $(( ms % 1000 )))" "$@"
}
docker_up() { docker info >/dev/null 2>&1; }
bun_version() { bun --version 2>/dev/null; }
lock_hash() { cat "$1/package.json" "$1/bun.lock" | sha256sum | cut -d' ' -f1; }

if ! docker_up && ! pgrep -x dockerd >/dev/null; then
  # A restored snapshot can hold the pid file of a dockerd that no longer exists. If another
  # process now has that pid, dockerd refuses to start.
  rm -f "$DOCKER_RUN_DIR/docker.pid" "$DOCKER_RUN_DIR/docker/containerd/containerd.pid"
  # Anonymous Docker Hub pulls from a shared cloud address hit its rate limit (429), so try a mirror first.
  # fd 3 is closed for dockerd: the hook waits for every holder of its stdout to exit.
  nohup dockerd --registry-mirror=https://mirror.gcr.io </dev/null >"$DOCKERD_LOG" 2>&1 3>&- &
fi

BUN_BEFORE="$(bun_version)"
if [ "$BUN_BEFORE" != "$PIN" ]; then
  tool="$TOOLS/bun/node_modules/.bin/bun"
  if [ "$("$tool" --version 2>/dev/null)" != "$PIN" ]; then
    bounded npm install --silent --no-audit --no-fund --prefix "$TOOLS/bun" "bun@$PIN"
  fi
  if [ "$("$tool" --version 2>/dev/null)" = "$PIN" ]; then
    for link in ${HLM_BUN_LINKS:-$(which -a bun 2>/dev/null) /usr/local/bin/bun}; do
      ln -sf "$tool" "$link"
    done
    hash -r
  fi
fi
BUN_NOW="$(bun_version)"

deps_ok=true
for dir in "$REPO" "$REPO/agent"; do
  want="$(lock_hash "$dir")"
  [ "$(cat "$dir/node_modules/.hlm-lock-hash" 2>/dev/null)" = "$want" ] && continue
  if (cd "$dir" && bounded bun install --frozen-lockfile); then
    printf '%s\n' "$want" >"$dir/node_modules/.hlm-lock-hash"
  else
    deps_ok=false
  fi
done

docker_ok=false
wait_until=$(( $(now_ms) + DOCKER_WAIT_MS ))
[ "$wait_until" -lt "$DEADLINE" ] || wait_until=$DEADLINE
while :; do
  if docker_up; then docker_ok=true; break; fi
  [ "$(now_ms)" -lt "$wait_until" ] || break
  sleep 0.5
done

if [ "$BUN_NOW" != "$PIN" ]; then
  echo "Box not ready: Bun is ${BUN_NOW:-not installed} and the pin is $PIN. Test failures here may come from the version, not from the change." >&3
elif ! $deps_ok; then
  echo "Box not ready: dependencies failed to install. Run \`bun run setup\` and read its output before anything else." >&3
elif ! $docker_ok; then
  echo "Box partly ready: Docker did not start (see $DOCKERD_LOG). Checks that need the local stack cannot run." >&3
elif [ "$BUN_BEFORE" != "$PIN" ]; then
  echo "Box ready. Bun was ${BUN_BEFORE:-not installed} and is now $PIN, the pinned version." >&3
else
  echo "Box ready: Bun $PIN, dependencies installed, Docker running." >&3
fi
exit 0
