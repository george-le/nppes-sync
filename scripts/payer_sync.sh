#!/usr/bin/env bash
# Run payer FHIR directory syncs through the app API and wait for each job to finish.
#
# Usage:
#   scripts/payer_sync.sh sync   <source> [--specialty CODE] [--max-pages N]
#   scripts/payer_sync.sh slices <source> <codes-file> [--retries N]
#   scripts/payer_sync.sh plans  <source>
#
#   sync    Start one sync job and wait for it. --max-pages 0 (the default) pulls every page.
#   slices  Run one sync per specialty code in <codes-file> (one code per line), one at a time.
#           A slice that fails is retried up to N times (default 1). Failures are listed at the end.
#   plans   Pull a payer's InsurancePlan and network Organization resources.
#
# Environment:
#   API   Base URL of the app. Default: http://100.73.215.72:3300
#
# Jobs resume from their last saved page if the app restarts. A resume link that has expired fails the job; rerun it.

set -euo pipefail

API="${API:-http://100.73.215.72:3300}"
POLL_SECONDS="${POLL_SECONDS:-30}"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
log() { printf '%s %s\n' "$(date +%T)" "$*"; }

# Pull a field out of a JSON document on stdin. Prints an empty string if it is missing.
json_field() {
  python3 -c 'import sys, json
try:
    value = json.load(sys.stdin).get(sys.argv[1], "")
except ValueError:
    value = ""
print("" if value is None else value)' "$1"
}

# Run a read-only SQL query through the app.
sql() {
  curl -sS -m 120 -X POST -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json, sys; print(json.dumps({"query": sys.argv[1]}))' "$1")" \
    "$API/api/sql"
}

# Start a sync job. Prints the job ID, or nothing (with the error on stderr) if the app refused it.
start_sync() {
  local source="$1" specialty="${2:-}" max_pages="${3:-0}" body response job_id
  body=$(python3 -c 'import json, sys
body = {"state": "CA", "maxPages": int(sys.argv[2]), "pageSize": 100}
if sys.argv[1]:
    body["specialty"] = sys.argv[1]
print(json.dumps(body))' "$specialty" "$max_pages")
  response=$(curl -sS -m 60 -X POST -H 'Content-Type: application/json' -d "$body" "$API/api/sources/$source/sync")
  job_id=$(printf '%s' "$response" | json_field jobId)
  if [ -z "$job_id" ]; then
    echo "could not start $source: $(printf '%s' "$response" | cut -c1-200)" >&2
    return 1
  fi
  printf '%s\n' "$job_id"
}

# Wait for a job to leave the "running" state. Prints the final row; returns 1 unless it succeeded.
wait_job() {
  local job_id="$1" row status
  while true; do
    row=$(sql "SELECT status, records_processed, details FROM sync_jobs WHERE id = '$job_id'")
    status=$(printf '%s' "$row" | python3 -c 'import sys, json
rows = json.load(sys.stdin).get("rows", [])
print(rows[0]["status"] if rows else "missing")')
    if [ "$status" != "running" ]; then break; fi
    sleep "$POLL_SECONDS"
  done
  printf '%s\n' "$row" | cut -c1-300
  [ "$status" = "success" ]
}

cmd_sync() {
  local source="${1:-}" specialty="" max_pages=0
  [ -n "$source" ] || usage
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --specialty) specialty="${2:?--specialty needs a code}"; shift 2 ;;
      --max-pages) max_pages="${2:?--max-pages needs a number}"; shift 2 ;;
      *) usage ;;
    esac
  done
  local job_id
  job_id=$(start_sync "$source" "$specialty" "$max_pages") || return 1
  log "started $job_id"
  wait_job "$job_id"
}

cmd_slices() {
  local source="${1:-}" codes_file="${2:-}" retries=1
  [ -n "$source" ] && [ -f "$codes_file" ] || usage
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --retries) retries="${2:?--retries needs a number}"; shift 2 ;;
      *) usage ;;
    esac
  done

  local total n=0 failed=() code attempt job_id ok
  total=$(grep -c . "$codes_file")
  while read -r code; do
    [ -n "$code" ] || continue
    n=$((n + 1))
    ok=false
    for attempt in $(seq 0 "$retries"); do
      if job_id=$(start_sync "$source" "$code" 0) && wait_job "$job_id" >/dev/null; then
        ok=true
        break
      fi
      log "[$n/$total] $code failed (attempt $((attempt + 1)) of $((retries + 1)))"
    done
    if $ok; then log "[$n/$total] $code ok"; else failed+=("$code"); fi
  done < "$codes_file"

  log "slices finished: $((n - ${#failed[@]})) ok, ${#failed[@]} failed"
  if [ ${#failed[@]} -gt 0 ]; then
    printf 'failed codes: %s\n' "${failed[*]}"
    return 1
  fi
}

cmd_plans() {
  local source="${1:-}"
  [ -n "$source" ] || usage
  curl -sS -m 1800 -X POST "$API/api/sources/$source/plans"
  echo
}

case "${1:-}" in
  sync)   shift; cmd_sync "$@" ;;
  slices) shift; cmd_slices "$@" ;;
  plans)  shift; cmd_plans "$@" ;;
  -h|--help|help) usage 0 ;;
  *) usage ;;
esac
