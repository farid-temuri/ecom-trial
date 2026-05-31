#!/usr/bin/env bash
# N full-suite runs launched in PARALLEL. Safe only while scoring is disabled
# (SCORE_POLL_TIMEOUT_MS small) — with no score fetch, tasksState is never
# written, so the cross-process write race that forces sequential mode is moot.
# Each run still trips BitGN's per-run rate limit independently and retries up
# to 3x with a 75s backoff. Web server off, trial-level CONCURRENCY=50 per run.
set -uo pipefail
cd "$(dirname "$0")/.."

N=${1:-5}
LOG_DIR="runs/_five-runs"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
SUMMARY="$LOG_DIR/$STAMP.parallel.runids.txt"
: > "$SUMMARY"

run_one() {
  local i=$1
  local attempt=0
  while :; do
    attempt=$((attempt + 1))
    local OUT="$LOG_DIR/$STAMP.run$i.attempt$attempt.log"
    echo "[$(date +%H:%M:%S)] run $i/$N attempt $attempt → $OUT"
    WEB_PORT=0 CONCURRENCY=50 SCORE_POLL_TIMEOUT_MS=${SCORE_POLL_TIMEOUT_MS:-1000} \
      bun run main.ts >"$OUT" 2>&1
    local rid
    rid=$(grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{6}' "$OUT" | head -1)
    # BitGN's startRun writes to a shared SQLite; concurrent launches can
    # collide with "database is locked" (a hard error, distinct from the
    # "run rate limit hit" string). Both are retryable here.
    if grep -qE "run rate limit hit|database is locked" "$OUT" && [ "$attempt" -lt 4 ]; then
      echo "[$(date +%H:%M:%S)]   run $i contention (rate-limit/db-lock), sleeping 75s then retrying"
      sleep 75
      continue
    fi
    echo "run $i: ${rid:-UNKNOWN}" >> "$SUMMARY"
    echo "[$(date +%H:%M:%S)]   run $i done → ${rid:-UNKNOWN}"
    break
  done
}

pids=()
for i in $(seq 1 "$N"); do
  run_one "$i" &
  pids+=($!)
  # Stagger so the brief startRun DB write doesn't collide across processes;
  # the long trial-execution phase still overlaps fully.
  sleep 5
done

for pid in "${pids[@]}"; do
  wait "$pid"
done

echo "[$(date +%H:%M:%S)] all $N parallel runs complete. runIds:"
cat "$SUMMARY"
