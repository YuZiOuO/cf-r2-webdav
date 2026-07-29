#!/usr/bin/env bash
set -euo pipefail

if ! command -v litmus >/dev/null 2>&1; then
  printf '%s\n' "litmus is required; install Apache Litmus before running this test." >&2
  exit 127
fi

litmus_username="test"
litmus_password="test"

base_url="http://127.0.0.1:8787"
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/cf-r2-webdav-litmus.XXXXXX")"

server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime_dir"
}

start_server() {
  XDG_CONFIG_HOME="$runtime_dir/config" bunx wrangler dev \
    --persist-to "$runtime_dir/state" \
    --log-level warn \
    --var "WEBDAV_USERNAME:$litmus_username" \
    --var "WEBDAV_PASSWORD:$litmus_password" &
  server_pid=$!
}

wait_for_server() {
  printf 'Waiting for server at %s' "$base_url"
  for _ in {1..60}; do
    if curl --silent --output /dev/null "$base_url/"; then
      printf ' ready (%s)\n' "$base_url"
      return 0
    fi
    printf '.'
    sleep 0.5
  done
  printf ' timed out\n'
  return 1
}

run_litmus() {
  local output_file="$runtime_dir/litmus.log"
  local status
  local failure_count

  set +e
  litmus -k "$base_url/" "$litmus_username" "$litmus_password" 2>&1 |
    tee "$output_file"
  status="${PIPESTATUS[0]}"
  set -e

  failure_count="$(grep -Ec 'FAIL \(|OOPS unexpected test result' "$output_file" || true)"
  if [[ "$failure_count" -eq 0 ]]; then
    return "$status"
  fi

  # Workers cannot send the HTTP 100 Continue interim response.
  if [[ "$failure_count" -eq 1 ]] &&
    grep -Eq 'expect100.*FAIL \(' "$output_file"; then
    return 0
  fi

  return 1
}

trap cleanup EXIT
start_server
wait_for_server
run_litmus
