#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
MAJOR_TAG="v${VERSION%%.*}"

test "$(bash "$ROOT/scripts/release-version.sh" "$VERSION")" = "$MAJOR_TAG"

for invalid in "v$VERSION" "${VERSION}.0" "01.2.3" "1.02.3" "1.2.03" "1.2" ""; do
  if bash "$ROOT/scripts/release-version.sh" "$invalid" >/dev/null 2>&1; then
    echo "release version validation unexpectedly accepted '$invalid'" >&2
    exit 1
  fi
done

if bash "$ROOT/scripts/release-version.sh" "99.98.97" >/dev/null 2>&1; then
  echo "release version validation accepted a version that differs from package.json" >&2
  exit 1
fi
