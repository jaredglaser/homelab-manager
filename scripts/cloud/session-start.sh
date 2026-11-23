#!/bin/bash
# The repo hook runs this in every Claude Code session, so it must do nothing outside a cloud box.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0

if ! pgrep -x dockerd >/dev/null; then
  # Anonymous Docker Hub pulls from a shared cloud address hit its rate limit (429), so try a mirror first.
  nohup dockerd --registry-mirror=https://mirror.gcr.io > /tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
exit 0
