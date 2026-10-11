#!/bin/bash
# Sequential LOCAL warm-up of every profile in one or more GoLogin folders.
# One profile at a time; a failed profile is cleaned up and the queue continues.
# The next profile never uses the proxy port of the profile that just opened a browser.
# Repeated --folder flags share one queue, so a port is not repeated across folders either.
# Paused profiles are skipped and their pause is never cleared.
# Before each profile, scripts/net-gate.mjs waits (WARMUP_NET_WAIT_MIN, default 15 min) for
# api.gologin.com and the GoLogin desktop API; if they stay down the batch stops and lists
# what is left. A profile deferred for that reason keeps its place and its port is not used.
# A profile that failed for infrastructure reasons is retried once at the end of the queue.
#   bash scripts/run-available-folder.sh                         Available Profiles
#   bash scripts/run-available-folder.sh --folder Harvest        another folder
#   bash scripts/run-available-folder.sh --folder Harvest --folder "Available Profiles"
#   bash scripts/run-available-folder.sh --dry-run --folder Harvest
#   WARMUP_LAST_PORT=5004 bash scripts/run-available-folder.sh
#   WARMUP_ONLY_IDS=<id>,<id> bash scripts/run-available-folder.sh --folder Harvest   only those profiles
# WARMUP_LAST_PORT is the proxy port that just opened a browser, so the first
# profile in this batch is not started on that same port.
set -u
cd "$(dirname "$0")/.." || exit 1

DRY_RUN=0
FOLDER_NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --folder)
      shift
      if [ -z "${1:-}" ]; then echo "REFUSED: --folder requires a name."; exit 2; fi
      FOLDER_NAMES+=("$1")
      ;;
    *) echo "REFUSED: unknown argument: $1"; exit 2 ;;
  esac
  shift
done
if [ ${#FOLDER_NAMES[@]} -eq 0 ]; then
  FOLDER_NAMES=("${WARMUP_FOLDER:-Available Profiles}")
fi
export WARMUP_FOLDERS="$(printf '%s\n' "${FOLDER_NAMES[@]}")"
if [ ${#FOLDER_NAMES[@]} -eq 1 ]; then
  export WARMUP_FOLDER="${FOLDER_NAMES[0]}"
else
  folder_label="${FOLDER_NAMES[0]}"
  for folder_name in "${FOLDER_NAMES[@]:1}"; do
    folder_label="$folder_label + $folder_name"
  done
  export WARMUP_FOLDER="$folder_label"
fi

export GOLOGIN_BROWSER_MODE=local
export SESSION_MINUTES=5,10
export TEST_RUN=0
export VERIFY_WARMUP=0
unset TEST_SESSION_MINUTES

LOCK=data/locks/browser.json

# Prints the pid holding the browser lock if that process is alive; prints nothing otherwise.
live_lock_pid() {
  [ -f "$LOCK" ] || return 0
  node -e '
    const fs = require("node:fs");
    let owner;
    try { owner = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { console.log("malformed"); process.exit(0); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) { console.log("malformed"); process.exit(0); }
    try { process.kill(owner.pid, 0); console.log(owner.pid); }
    catch (error) { if (error.code !== "ESRCH") console.log(owner.pid); }
  ' "$LOCK"
}

# Other warm-up runners alive right now. This script and its own subshells (which share
# its command line) are excluded by walking each match's parent chain.
other_runners() {
  local pid p i mine
  for pid in $(pgrep -f 'src/index\.js (once|schedule)|continue-available-local\.sh|run-available-folder\.sh'); do
    p="$pid"; mine=0
    for i in 1 2 3 4 5; do
      if [ "$p" = "$$" ]; then mine=1; break; fi
      p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
      if [ -z "$p" ] || [ "$p" = 1 ]; then break; fi
    done
    if [ "$mine" -eq 0 ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
  done
}

refuse_if_busy() {
  local pid runners
  pid="$(live_lock_pid)"
  if [ "$pid" = "malformed" ]; then
    echo "REFUSED: $LOCK is malformed. Inspect it manually; no browser was started."
    exit 3
  fi
  if [ -n "$pid" ]; then
    echo "REFUSED: browser lock is held by live pid $pid ($(ps -o command= -p "$pid" 2>/dev/null | cut -c1-80))."
    echo "Another warm-up is running. Wait for it to finish; no browser was started."
    exit 3
  fi
  runners="$(other_runners)"
  if [ -n "$runners" ]; then
    echo "REFUSED: another warm-up runner is alive (pids: $(echo "$runners" | tr '\n' ' '))."
    echo "It may be between profiles. Wait for it to finish; no browser was started."
    exit 3
  fi
}

QUEUE="$(mktemp -t available-folder-queue)"
RETRY="$(mktemp -t available-folder-retry)"
RETRIED="$(mktemp -t available-folder-retried)"
DEFERS="$(mktemp -t available-folder-defers)"
trap 'rm -f "$QUEUE" "$RETRY" "$RETRIED" "$DEFERS"' EXIT

if [ "$DRY_RUN" -eq 1 ]; then
  pid="$(live_lock_pid)"
  [ -n "$pid" ] && echo "NOTE: browser lock currently held by pid $pid; a real run would refuse."
  node scripts/resolve-available-folder.mjs "$QUEUE" --dry-run || exit $?
  echo "--- pool (dry run, nothing started; live run reorders by proxy port) ---"
  awk -F'\t' '{ printf "%s port %s\n", $2, ($3 == "" ? "none" : $3) }' "$QUEUE"
  exit 0
fi

mkdir -p logs
LOG="logs/available-folder-$(date +%Y%m%d-%H%M%S).log"
echo "Log: $LOG"
exec > >(tee -a "$LOG") 2>&1

echo "=== FOLDER BATCH $(date -u +%Y-%m-%dT%H:%M:%SZ) folder=\"$WARMUP_FOLDER\" mode=$GOLOGIN_BROWSER_MODE SESSION_MINUTES=$SESSION_MINUTES initial_port=${WARMUP_LAST_PORT:--} ==="
refuse_if_busy

caffeinate -dims -w $$ &

trap 'echo "=== INTERRUPTED $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="; exit 130' INT TERM

node scripts/resolve-available-folder.mjs "$QUEUE"
code=$?
if [ "$code" -ne 0 ]; then
  echo "=== ABORT: could not resolve the folder (exit $code); no browser was started ==="
  exit "$code"
fi

stop_profile() {
  local id="$1"
  node --input-type=module -e '
    import "dotenv/config";
    const id = process.argv[1];
    const token = process.env.GL_API_TOKEN || process.env.GOLOGIN_API_TOKEN || "";
    if (!token) { console.log("no token; not stopping local profile"); process.exit(0); }
    try {
      const response = await fetch("http://127.0.0.1:36912/browser/stop-profile", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: id }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      console.log(`stop-profile ${id} HTTP ${response.status} ${text.slice(0, 180)}`);
    } catch (error) {
      console.log(`stop-profile ${id} failed: ${error.message}`);
    }
  ' "$id" || true
}

clear_after_failure() {
  local id="$1" name="$2"
  echo "=== SKIP $name: warm-up failed; continuing with the next profile ==="
  if [ -f "$LOCK" ]; then
    if npm run unlock -- --lock browser; then
      echo "=== SKIP $name: released dead browser lock ==="
    else
      echo "=== SKIP $name: browser lock still held ==="
    fi
  fi
  stop_profile "$id"
}

print_left() {
  echo "--- left ---"
  cat "$QUEUE" "$RETRY" | awk -F'\t' 'NF { printf "%s port %s\n", $2, ($3 == "" ? "none" : $3) }'
}

# Prints the profile's pause reason if its state file has one; prints nothing otherwise.
paused_reason() {
  node -e '
    const fs = require("node:fs");
    try { const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (s.pause) console.log(s.pause.kind || "paused"); }
    catch { console.log("unreadable"); }
  ' "data/state-$1.json"
}

MAX_DEFERRALS=3
total=$(grep -c . "$QUEUE" || true)
n=0; ok=0; failed=0; infra=0; interrupted=0; deferred=0
last_port="${WARMUP_LAST_PORT:--}"
[ -n "$last_port" ] || last_port="-"
while [ -s "$QUEUE" ] || [ -s "$RETRY" ]; do
  if [ ! -s "$QUEUE" ]; then
    echo "=== RETRY PASS: $(grep -c . "$RETRY") profile(s) that failed for infrastructure reasons get one more try ==="
    cat "$RETRY" > "$QUEUE"
    : > "$RETRY"
  fi
  if ! node scripts/net-gate.mjs; then
    echo "=== STOP: network or GoLogin API unavailable; no further browser was started. Re-run the batch when connectivity returns. ==="
    print_left
    break
  fi
  if [ -f "$LOCK" ]; then
    npm run unlock -- --lock browser >/dev/null 2>&1 || true
    pid="$(live_lock_pid)"
    if [ -n "$pid" ]; then
      echo "=== STOP: browser lock taken by pid $pid; ending batch without starting another browser ==="
      break
    fi
  fi
  line="$(node scripts/proxy-queue.mjs pick "$QUEUE" "$last_port")"
  pick_code=$?
  if [ "$pick_code" -eq 2 ]; then
    echo "=== STOP: every remaining profile uses proxy port $last_port. Not starting another browser on that port. ==="
    print_left
    break
  fi
  if [ "$pick_code" -ne 0 ]; then
    echo "=== ABORT: could not choose the next profile (exit $pick_code); no further browser was started ==="
    break
  fi
  IFS=$'\t' read -r id name port <<<"$line"
  [ -z "$id" ] && continue
  n=$((n + 1))
  echo "=== START [$n/$total] $name port ${port:-none} (previous port: $last_port) ($id) $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  snippet="$(mktemp)"
  npm run once -- --profile "$id" 2>&1 | tee "$snippet"
  code=${PIPESTATUS[0]}
  echo "=== END $name port ${port:-none} exit:$code $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  if grep -q "Session deferred:" "$snippet"; then
    rm -f "$snippet"
    n=$((n - 1))
    deferred=$((deferred + 1))
    echo "$id" >> "$DEFERS"
    times=$(grep -cx "$id" "$DEFERS" || true)
    echo "=== PORT ${port:-none} not consumed: $name deferred because GoLogin was unreachable; nothing was counted ==="
    if [ "$times" -lt "$MAX_DEFERRALS" ]; then
      printf '%s\t%s\t%s\n' "$id" "$name" "$port" >> "$QUEUE"
    else
      echo "=== LEFT $name: deferred $times times; not retrying it in this batch ==="
    fi
    if [ -f "$LOCK" ]; then npm run unlock -- --lock browser >/dev/null 2>&1 || true; fi
    continue
  fi
  # A port is used once GoLogin accepted the start. A run that clearly never opened a
  # browser (blocked, GoLogin refusal) leaves it free; anything ambiguous counts as used.
  if grep -qE "GoLogin accepted the start request|Started GoLogin profile|already-running local Orbita" "$snippet"; then
    last_port="${port:-none}"
  elif grep -qE "Session blocked:|No browser was started" "$snippet"; then
    echo "=== PORT ${port:-none} not consumed: $name never opened a browser ==="
  else
    last_port="${port:-none}"
  fi
  kind="$(sed -n 's/^Session failure kind: //p' "$snippet" | tail -1)"
  rm -f "$snippet"
  if [ "$code" -ne 0 ] || [ -f "$LOCK" ]; then
    clear_after_failure "$id" "$name"
    pause="$(paused_reason "$id")"
    if [ "$kind" = "operator" ]; then
      interrupted=$((interrupted + 1))
      echo "=== $name interrupted by the operator; not counted as a failed session ==="
    elif [ "$kind" = "infra" ] && [ -z "$pause" ]; then
      infra=$((infra + 1))
      if grep -qx "$id" "$RETRIED"; then
        echo "=== $name failed for infrastructure reasons again; not retrying it in this batch ==="
      else
        echo "$id" >> "$RETRIED"
        printf '%s\t%s\t%s\n' "$id" "$name" "$port" >> "$RETRY"
        echo "=== RETRY LATER $name: infrastructure failure; queued once at the end of this batch ==="
      fi
    else
      failed=$((failed + 1))
      [ -n "$pause" ] && echo "=== $name is paused ($pause); its pause is left for manual review ==="
    fi
  else
    ok=$((ok + 1))
  fi
done
echo "=== BATCH DONE $(date -u +%Y-%m-%dT%H:%M:%SZ) ran=$n ok=$ok failed=$failed infra=$infra interrupted=$interrupted deferred=$deferred log=$LOG ==="
