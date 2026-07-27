#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mode=${1:-check}; config=${2:-.github/octestra/config.yml}
while IFS== read -r name value; do
  actual=$(gh variable get "$name" 2>/dev/null || true)
  if [[ "$mode" == sync ]]; then gh variable set "$name" --body "$value"; elif [[ "$actual" != "$value" ]]; then echo "$name drifted" >&2; exit=1; fi
done < <(node "$script_dir/octestra-vars.mjs" "$config")
exit ${exit:-0}
