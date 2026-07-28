#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/octestra-install-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT

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
if [[ "$args" == *"/repos/ainame/octestra/tarball/main"* ]]; then
  cat "$OCTESTRA_TEST_ARCHIVE"
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
  grep -q '"name": "Validation"' "$input"
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
  cat <<'OPTIONS'
Todo	101
Ready	102
In Progress	103
OPTIONS
  if [[ "${OCTESTRA_TEST_MISSING_VALIDATION:-false}" != "true" ]]; then
    printf 'Validation\t104\n'
  fi
  cat <<'OPTIONS'
Human Review	105
Blocked	106
Done	107
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
grep -q 'field_id: "9001"' "$TEMP_DIR/consumer/.github/octestra/config.yml"
grep -q 'todo: "101"' "$TEMP_DIR/consumer/.github/octestra/config.yml"
grep -q 'validation: "104"' "$TEMP_DIR/consumer/.github/octestra/config.yml"
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
    bash -s -- \
      --org example-org \
      --status-field "AI Task Status" \
      --target "$TEMP_DIR/consumer-piped" \
      --skill-target agents \
      --yes
test -f "$TEMP_DIR/consumer-piped/.github/workflows/octestra-lifecycle.yml"
test -f "$TEMP_DIR/consumer-piped/.agents/skills/octestra-setup-migration-epic/SKILL.md"

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
test -f "$TEMP_DIR/consumer/.github/workflows/octestra-loop-triage-todo.yml"
grep -q 'operation: lifecycle/prepare-task' "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-in-progress.yml"
grep -q 'operation: lifecycle/prepare-validation' "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-validation.yml"
grep -q 'previous-status-id: \${{ github.event.changes.issue_field_value.from.option.id }}' "$orchestrator"
grep -q 'current-status-id: \${{ github.event.issue_field_value.option.id }}' "$orchestrator"
grep -q 'owner: \${{ github.repository_owner }}' "$orchestrator"
grep -q 'repositories: \${{ github.repository }}' "$orchestrator"
grep -q 'LOOP_CONTEXT: |' "$TEMP_DIR/consumer/.github/workflows/octestra-loop-triage-todo.yml"
grep -q 'config-ref: ${{ inputs.config-ref }}' "$TEMP_DIR/consumer/.github/workflows/octestra-loop-triage-todo.yml"
for variable in OCTESTRA_GITHUB_APP_CLIENT_ID OCTESTRA_ORCHESTRATION_RUNNER OCTESTRA_AGENT_RUNNER OCTESTRA_STATUS_FIELD_ID; do
  grep -q "$variable" "$ROOT/scripts/octestra-vars.mjs"
done

retrospective="$TEMP_DIR/consumer/.github/workflows/octestra-loop-retrospective.yml"
test -f "$retrospective"
test -f "$TEMP_DIR/consumer/.github/octestra/prompts/loop-retrospective.md.hbs"
grep -q 'LOOP_CONTEXT: |' "$retrospective"
grep -q 'loop-issues: \${{ needs.select.outputs.issues }}' "$retrospective"
grep -q 'persist-credentials: false' "$retrospective"
# The aggregate agent job must stay unprivileged: it hands over a patch instead of pushing.
! grep -q 'app-token' <(sed -n '/^  agent:/,/^  finalize:/p' "$retrospective")
for loop_id in triage-todo retrospective; do
  grep -q "^#   $loop_id:" "$TEMP_DIR/consumer/.github/octestra/config.yml"
done

printf 'Installer tests passed\n'
