#!/usr/bin/env bash
# 5 sequential full-suite runs on the CURRENT prompt, trial-level parallelism
# via CONCURRENCY=50, web server off. Sequential keeps tasksState averaging
# correct and avoids BitGN's per-run rate limit. Retries a run up to 3x if it
# trips "run rate limit hit", with a 75s backoff (mirrors run-experiment.ts).
set -uo pipefail
cd "$(dirname "$0")/.."

N=${1:-5}
LOG_DIR="runs/_five-runs"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
SUMMARY="$LOG_DIR/$STAMP.runids.txt"
: > "$SUMMARY"

for i in $(seq 1 "$N"); do
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    OUT="$LOG_DIR/$STAMP.run$i.attempt$attempt.log"
    echo "[$(date +%H:%M:%S)] run $i/$N attempt $attempt → $OUT"
    WEB_PORT=0 CONCURRENCY=50 bun run main.ts >"$OUT" 2>&1
    rid=$(grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{6}' "$OUT" | head -1)
    if grep -q "run rate limit hit" "$OUT" && [ "$attempt" -lt 4 ]; then
      echo "[$(date +%H:%M:%S)]   rate-limit hit, sleeping 75s then retrying"
      sleep 75
      continue
    fi
    echo "run $i: ${rid:-UNKNOWN}" >> "$SUMMARY"
    echo "[$(date +%H:%M:%S)]   run $i done → ${rid:-UNKNOWN}"
    break
  done
  if [ "$i" -lt "$N" ]; then sleep 15; fi
done

echo "[$(date +%H:%M:%S)] all $N runs complete. runIds:"
cat "$SUMMARY"
