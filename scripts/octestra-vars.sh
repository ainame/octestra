#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mode=${1:-check}
config=${2:-.github/octestra/config.yml}
status=0
while IFS== read -r name value; do
  actual=$(gh variable get "$name" 2>/dev/null || true)
  actual=${actual%$'\n'}
  if [[ "$mode" == "sync" ]]; then
    gh variable set "$name" --body "$value"
  elif [[ "$actual" != "$value" ]]; then
    echo "$name drifted" >&2
    status=1
  fi
done < <(node "$script_dir/octestra-vars.mjs" "$config")
exit "$status"
