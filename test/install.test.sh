#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/octestra-install-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT

count_references() {
  local pattern="$1"
  local path="$2"

  { grep -R -o -- "$pattern" "$path" || true; } | wc -l | tr -d ' '
}

mkdir -p "$TEMP_DIR/bin" "$TEMP_DIR/consumer"
git -C "$TEMP_DIR/consumer" init --quiet
git -C "$TEMP_DIR/consumer" remote add origin git@github.com:example-org/consumer.git

cat > "$TEMP_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "auth status" ]]; then
  exit 0
fi

if [[ "$1 $2" == "repo view" ]]; then
  if [[ "${OCTESTRA_TEST_REPO_VIEW_FAIL:-false}" == "true" ]]; then
    exit 1
  fi
  printf 'example-org\n'
  exit 0
fi

if [[ "$1 $2" == "variable set" ]]; then
  exit 0
fi

if [[ "$1" != "api" ]]; then
  exit 1
fi

args="$*"
if [[ "$args" == *"/repos/ainame/octestra/tarball/"* ]]; then
  printf '%s\n' "${args##*/tarball/}" > "${OCTESTRA_TEST_TARBALL_REF:-/dev/null}"
  cat "$OCTESTRA_TEST_ARCHIVE"
  exit 0
fi

# Tag listing for the ref the generated workflows are pinned to. An untagged repository
# answers with a failure, which the installer reads as "fall back to the default branch".
if [[ "$args" == *"/tags"* ]]; then
  if [[ -z "${OCTESTRA_TEST_TAGS:-}" ]]; then
    exit 1
  fi
  for tag in ${OCTESTRA_TEST_TAGS}; do
    printf '%s\n' "$tag"
  done
  exit 0
fi

if [[ "$args" == *"--method POST"* ]]; then
  input=""
  while (( $# > 0 )); do
    if [[ "$1" == "--input" ]]; then
      input="$2"
      break
    fi
    shift
  done
  grep -q '"name": "AI Task Status"' "$input"
  grep -q '"name":"Validation","color":"pink","priority":4' "$input"
  touch "$OCTESTRA_TEST_STATE"
  printf '{}\n'
  exit 0
fi

if [[ "$args" == *".data_type"* ]]; then
  if [[ -f "$OCTESTRA_TEST_STATE" ]]; then
    printf '9001\tAI Task Status\tsingle_select\n'
  fi
  exit 0
fi

if [[ "$args" == *".options"* ]]; then
  # Operations address statuses by name, so the installer asks for option names only.
  cat <<'OPTIONS'
Todo
Ready
In Progress
OPTIONS
  if [[ "${OCTESTRA_TEST_MISSING_VALIDATION:-false}" != "true" ]]; then
    printf 'Validation\n'
  fi
  cat <<'OPTIONS'
Human Review
Blocked
Done
OPTIONS
  exit 0
fi

exit 1
EOF
chmod +x "$TEMP_DIR/bin/gh"

PATH="$TEMP_DIR/bin:$PATH" \
OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer" \
    --source-dir "$ROOT" \
    --skill-target codex \
    --yes

orchestrator="$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle.yml"
test -f "$orchestrator"
test -f "$TEMP_DIR/consumer/.github/octestra/config.yml"
test -f "$TEMP_DIR/consumer/.github/octestra/prompts/lifecycle-in-progress.md.hbs"
test -f "$TEMP_DIR/consumer/.github/octestra/prompts/lifecycle-validation.md.hbs"
test -f "$TEMP_DIR/consumer/.codex/skills/octestra-setup-migration-epic/SKILL.md"
ruby -c "$TEMP_DIR/consumer/.codex/skills/octestra-setup-migration-epic/scripts/setup_epic.rb" >/dev/null
# An upstream repository with no tags leaves the reference on the default branch.
grep -q 'uses: ainame/octestra@main' "$orchestrator"
grep -q 'field_id: "9001"' "$TEMP_DIR/consumer/.github/octestra/config.yml"
grep -q 'field_name: "AI Task Status"' "$TEMP_DIR/consumer/.github/octestra/config.yml"
# Operations address statuses by name, so no option IDs are written to config.yml.
! grep -q 'options:' "$TEMP_DIR/consumer/.github/octestra/config.yml"
node -e 'require("yaml").parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEMP_DIR/consumer/.github/octestra/config.yml"

missing_option_output="$TEMP_DIR/missing-option-output"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_MISSING_VALIDATION=true \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
    bash "$ROOT/install.sh" \
      --org example-org \
      --status-field "AI Task Status" \
      --target "$TEMP_DIR/consumer" \
      --source-dir "$ROOT" \
      --skill-target codex \
      --yes >"$missing_option_output" 2>&1; then
  echo "installer unexpectedly accepted a field with a missing option" >&2
  exit 1
fi
grep -q "missing required options: Validation" "$missing_option_output"
grep -q "curl --fail --silent --show-error --location" "$missing_option_output"
grep -q '"name":"Validation","color":"pink","priority":4' "$missing_option_output"
grep -q "issue-fields/9001" "$missing_option_output"
grep -q -- "--data-binary @-" "$missing_option_output"

mkdir -p "$TEMP_DIR/consumer-oidc"
git -C "$TEMP_DIR/consumer-oidc" init --quiet
git -C "$TEMP_DIR/consumer-oidc" remote add origin git@github.com:example-org/consumer-oidc.git
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer-oidc" \
    --source-dir "$ROOT" \
    --skill-target codex \
    --yes \
    --github-app-client-id client-id-123 \
    --enable-oidc
if grep -R '^  # id-token: write$' "$TEMP_DIR/consumer-oidc/.github/workflows" >/dev/null; then
  echo "OIDC-enabled install left a disabled id-token permission" >&2
  exit 1
fi
grep -q 'client_id: "client-id-123"' "$TEMP_DIR/consumer-oidc/.github/octestra/config.yml"

# A fork install repoints every action reference at the organization's own fork, so the
# consumer runs only code that organization controls.
template_references=$(count_references 'ainame/octestra@main' "$ROOT/templates")
test "$template_references" -gt 0
mkdir -p "$TEMP_DIR/consumer-fork"
git -C "$TEMP_DIR/consumer-fork" init --quiet
git -C "$TEMP_DIR/consumer-fork" remote add origin git@github.com:example-org/consumer-fork.git
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer-fork" \
    --source-dir "$ROOT" \
    --skill-target codex \
    --yes \
    --fork
grep -q 'uses: example-org/octestra@main' "$TEMP_DIR/consumer-fork/.github/workflows/octestra-lifecycle.yml"
fork_references=$(count_references 'example-org/octestra@main' "$TEMP_DIR/consumer-fork/.github")
if [[ "$fork_references" != "$template_references" ]]; then
  echo "fork install rewrote $fork_references of $template_references action references" >&2
  exit 1
fi
leftover_references=$(count_references 'ainame/octestra' "$TEMP_DIR/consumer-fork/.github")
if [[ "$leftover_references" != "0" ]]; then
  echo "fork install left $leftover_references upstream action references" >&2
  exit 1
fi

# An upstream install pins the newest plain version tag: 1.10 outranks 1.9, and a release
# candidate is not a plain version.
mkdir -p "$TEMP_DIR/consumer-tagged"
git -C "$TEMP_DIR/consumer-tagged" init --quiet
git -C "$TEMP_DIR/consumer-tagged" remote add origin git@github.com:example-org/consumer-tagged.git
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  OCTESTRA_TEST_TAGS="v1.9.0 v1.10.0 v1.11.0-rc1 nightly" \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer-tagged" \
    --source-dir "$ROOT" \
    --skill-target codex \
    --yes
tagged_references=$(count_references 'ainame/octestra@v1\.10\.0' "$TEMP_DIR/consumer-tagged/.github")
if [[ "$tagged_references" != "$template_references" ]]; then
  echo "tagged install pinned $tagged_references of $template_references action references" >&2
  exit 1
fi
if grep -R 'ainame/octestra@main' "$TEMP_DIR/consumer-tagged/.github" >/dev/null; then
  echo "tagged install left an unpinned action reference" >&2
  exit 1
fi

# An explicit --repository/--ref pair wins over both defaults, tags included.
mkdir -p "$TEMP_DIR/consumer-pinned"
git -C "$TEMP_DIR/consumer-pinned" init --quiet
git -C "$TEMP_DIR/consumer-pinned" remote add origin git@github.com:example-org/consumer-pinned.git
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  OCTESTRA_TEST_TAGS="v1.10.0" \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer-pinned" \
    --source-dir "$ROOT" \
    --skill-target codex \
    --yes \
    --repository other-org/octestra-mirror \
    --ref release/2026-07
grep -q 'uses: other-org/octestra-mirror@release/2026-07' \
  "$TEMP_DIR/consumer-pinned/.github/workflows/octestra-lifecycle.yml"

# A ref that could reach sed as something other than a git ref is rejected.
rejected_ref_output="$TEMP_DIR/rejected-ref-output"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
    bash "$ROOT/install.sh" \
      --org example-org \
      --target "$TEMP_DIR/consumer-pinned" \
      --source-dir "$ROOT" \
      --skill-target codex \
      --yes \
      --ref 'main|sed-injection' >"$rejected_ref_output" 2>&1; then
  echo "installer unexpectedly accepted a malformed ref" >&2
  exit 1
fi
grep -q "must be a git ref" "$rejected_ref_output"

mkdir -p "$TEMP_DIR/archive/octestra-main" "$TEMP_DIR/consumer-piped"
cp -R "$ROOT/templates" "$TEMP_DIR/archive/octestra-main/templates"
cp -R "$ROOT/scripts" "$TEMP_DIR/archive/octestra-main/scripts"
tar -czf "$TEMP_DIR/octestra-main.tar.gz" -C "$TEMP_DIR/archive" octestra-main
git -C "$TEMP_DIR/consumer-piped" init --quiet
git -C "$TEMP_DIR/consumer-piped" remote add origin git@github.com:example-org/consumer-piped.git

cat "$ROOT/install.sh" |
  PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_ARCHIVE="$TEMP_DIR/octestra-main.tar.gz" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_TAGS="v1.9.0 v1.10.0" \
  OCTESTRA_TEST_TARBALL_REF="$TEMP_DIR/tarball-ref" \
    bash -s -- \
      --org example-org \
      --status-field "AI Task Status" \
      --target "$TEMP_DIR/consumer-piped" \
      --skill-target agents \
      --yes
test -f "$TEMP_DIR/consumer-piped/.github/workflows/octestra-lifecycle.yml"
test -f "$TEMP_DIR/consumer-piped/.agents/skills/octestra-setup-migration-epic/SKILL.md"
# Templates are downloaded from the same ref the generated workflows call.
grep -q '^v1\.10\.0$' "$TEMP_DIR/tarball-ref"
grep -q 'uses: ainame/octestra@v1\.10\.0' \
  "$TEMP_DIR/consumer-piped/.github/workflows/octestra-lifecycle.yml"

PATH="$TEMP_DIR/bin:$PATH" \
OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer" \
    --source-dir "$ROOT" \
    --skill-target codex \
    --github-app-client-id replacement-client-id \
    --yes >/dev/null
grep -q 'client_id: "replacement-client-id"' "$TEMP_DIR/consumer/.github/octestra/config.yml"

test -f "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-in-progress.yml"
test -f "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-validation.yml"
grep -q 'operation: lifecycle/prepare-task' "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-in-progress.yml"
grep -q 'operation: lifecycle/prepare-validation' "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-validation.yml"
grep -q 'owner: \${{ github.repository_owner }}' "$orchestrator"
grep -q 'repositories: \${{ github.repository }}' "$orchestrator"
for variable in OCTESTRA_GITHUB_APP_CLIENT_ID OCTESTRA_ORCHESTRATION_RUNNER OCTESTRA_AGENT_RUNNER OCTESTRA_STATUS_FIELD_ID; do
  grep -q "$variable" "$ROOT/scripts/octestra-vars.mjs"
done

printf 'Installer tests passed\n'
