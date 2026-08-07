#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION="${1-}"

if ! printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "version must use the MAJOR.MINOR.PATCH format from package.json" >&2
  exit 1
fi

package_version=$(node -p "require('$ROOT/package.json').version")
if [[ "$VERSION" != "$package_version" ]]; then
  echo "version $VERSION does not match package.json version $package_version" >&2
  exit 1
fi

printf 'v%s\n' "${VERSION%%.*}"
