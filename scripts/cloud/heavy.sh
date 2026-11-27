#!/bin/bash
# Runs one heavy command at a time on a shared box: scripts/cloud/heavy.sh <cmd...>
LOCK="${HLM_HEAVY_LOCK:-/home/claude/work/heavy.lock}"
WAIT_SECONDS="${HLM_HEAVY_WAIT_SECONDS:-600}"
RUN_SECONDS="${HLM_HEAVY_RUN_SECONDS:-1200}"

[ $# -gt 0 ] || { echo "Usage: scripts/cloud/heavy.sh <command...>" >&2; exit 64; }
minutes() { awk -v s="$1" 'BEGIN { printf "%g", s / 60 }'; }

describe_holder() {
  local inode pid cmd elapsed started
  if read -r pid started cmd 2>/dev/null <"$LOCK.holder" &&kill -0 "$pid" 2>/dev/null; then
    echo "$cmd, running for $(( ($(date +%s) - started) / 60 )) minutes"
    return
  fi
  # A holder that took the lock with plain flock left no record, so it is found through /proc/locks.
  inode="$(stat -c %i "$LOCK")"
  pid="$(awk -v ino="$inode" '$2 == "FLOCK" { split($6, f, ":"); if (f[3] == ino) { print $5; exit } }' /proc/locks)"
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || { echo "an unknown command, running for an unknown time"; return; }
  mapfile -d '' -t argv <"/proc/$pid/cmdline"
  local i
  for i in "${!argv[@]}"; do
    case "${argv[$i]}" in
      */heavy.sh) cmd="${argv[*]:$((i + 1))}"; break ;;
      "$LOCK") cmd="${argv[*]:$((i + 1))}"; break ;;
    esac
  done
  elapsed="$(ps -o etimes= -p "$pid" | tr -d ' ')"
  echo "${cmd:-${argv[*]}}, running for $(( ${elapsed:-0} / 60 )) minutes"
}

mkdir -p "$(dirname "$LOCK")"
exec 9>>"$LOCK"
if ! flock -n 9; then
  echo "Waiting for another heavy command to finish: $(describe_holder)." >&2
  if ! flock -w "$WAIT_SECONDS" 9; then
    echo "Gave up after waiting $(minutes "$WAIT_SECONDS") minutes. Nothing was run." >&2
    exit 75
  fi
fi
printf '%s %s %s\n' "$$" "$(date +%s)" "$*" >"$LOCK.holder"

# fd 9 is closed for the command, so a daemon it leaves behind cannot keep holding the lock.
timeout -k 10 "$RUN_SECONDS" "$@" 9>&-
status=$?
if [ "$status" -eq 124 ]; then
  echo "Stopped after $(minutes "$RUN_SECONDS") minutes: $*. It did not finish." >&2
fi
exit "$status"
