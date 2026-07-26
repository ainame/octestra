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

orchestrator="$TEMP_DIR/consumer/.github/workflows/octestra-orchestrator.yml"
lifecycle="$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle.yml"
validation="$TEMP_DIR/consumer/.github/workflows/octestra-validation.yml"
in_progress="$TEMP_DIR/consumer/.github/workflows/octestra-in-progress.yml"
test -f "$orchestrator"
test -f "$lifecycle"
test -f "$validation"
test -f "$in_progress"
test -f "$TEMP_DIR/consumer/.github/octestra-prompts/octestra-in-progress.md.hbs"
test -f "$TEMP_DIR/consumer/.github/octestra-prompts/octestra-validation.md.hbs"
test -f "$TEMP_DIR/consumer/.codex/skills/octestra-setup-migration-epic/SKILL.md"
test -f "$TEMP_DIR/consumer/.codex/skills/octestra-setup-migration-epic/scripts/setup_epic.rb"
ruby -c "$TEMP_DIR/consumer/.codex/skills/octestra-setup-migration-epic/scripts/setup_epic.rb" >/dev/null
test ! -e "$TEMP_DIR/consumer/.claude"
test ! -e "$TEMP_DIR/consumer/.agents"

grep -q 'github.event.issue_field.id == 9001' "$orchestrator"
grep -q '"status_field_name": "AI Task Status"' "$orchestrator"
grep -q '"todo": 101' "$orchestrator"
grep -q '"validation": 104' "$orchestrator"
grep -q '"done": 107' "$orchestrator"
grep -q 'OCTESTRA_GITHUB_APP_CLIENT_ID:' "$orchestrator"
grep -q 'OCTESTRA_WORKFLOW_CONTEXT:' "$orchestrator"
grep -q 'OCTESTRA_GITHUB_APP_PRIVATE_KEY - the private key for this App client ID' "$orchestrator"
grep -q 'github-app-client-id:.*\\*github-app-client-id' "$orchestrator"
grep -q 'workflow-context:' "$orchestrator"
grep -q 'workflow-context:.*\\*workflow-context' "$orchestrator"
grep -q '"orchestration": "ubuntu-slim"' "$orchestrator"
grep -q '"agent": "ubuntu-latest"' "$orchestrator"
grep -q '"template": "octestra/{epic_id}/issue-{issue_number}"' "$orchestrator"
grep -q 'workflow-context:.*\\*workflow-context' "$orchestrator"
grep -q 'github_app_private_key:' "$lifecycle"
grep -q 'Private key for the task GitHub App' "$lifecycle"
grep -q 'client-id:.*inputs.github-app-client-id' "$in_progress"
grep -q 'client-id:.*inputs.github-app-client-id' "$validation"
grep -q 'owner:.*github.repository_owner' "$lifecycle"
grep -q 'owner:.*github.repository_owner' "$in_progress"
grep -q 'owner:.*github.repository_owner' "$validation"
grep -q 'repositories:.*github.repository' "$lifecycle"
grep -q 'repositories:.*github.repository' "$in_progress"
grep -q 'repositories:.*github.repository' "$validation"
grep -q 'operation: prepare-task' "$in_progress"
grep -q 'operation: prepare-validation' "$validation"
grep -q 'operation: finalize-validation' "$validation"
grep -q 'lifecycle-context:.*inputs.lifecycle-context' "$in_progress"
grep -q 'lifecycle-context:.*inputs.lifecycle-context' "$validation"
grep -q 'workflow-context:.*inputs.workflow-context' "$in_progress"
grep -q 'workflow-context:.*inputs.workflow-context' "$validation"
grep -q 'runs-on: ubuntu-slim' "$orchestrator"
grep -q 'operation: finalize-merged-task' "$orchestrator"
if grep -q 'fromJSON(env.OCTESTRA_WORKFLOW_CONTEXT)' "$orchestrator"; then
  echo "orchestrator uses env in a jobs.runs-on expression" >&2
  exit 1
fi
grep -q '^  # id-token: write$' "$orchestrator"
if grep -R -E 'agent_api_key|agent-api-key|failure-runner' \
  "$TEMP_DIR/consumer/.github/workflows" >/dev/null; then
  echo "generated workflow still exposes an unnecessary agent API key or failure runner" >&2
  exit 1
fi
if grep -Eq 'inputs\\.(issue-number|status-field-name|trigger-actor|trigger-actor-type)' \
  "$in_progress" "$validation"; then
  echo "state workflow still exposes decomposed lifecycle inputs" >&2
  exit 1
fi
if grep -R -E 'github-app-id|OCTESTRA_GITHUB_APP_ID|^[[:space:]]+app-id:' \
  "$TEMP_DIR/consumer/.github/workflows" >/dev/null; then
  echo "generated workflow still uses the deprecated GitHub App ID input" >&2
  exit 1
fi
if grep -R "__OCTESTRA_" "$TEMP_DIR/consumer" >/dev/null; then
  echo "unresolved installer placeholder" >&2
  exit 1
fi
node -e \
  'require("yaml").parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "$orchestrator"
node -e \
  'require("yaml").parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "$validation"

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
for workflow in octestra-orchestrator.yml octestra-lifecycle.yml octestra-in-progress.yml octestra-validation.yml; do
  grep -q '^  id-token: write$' "$TEMP_DIR/consumer-oidc/.github/workflows/$workflow"
done
grep -q 'OCTESTRA_GITHUB_APP_CLIENT_ID:.*client-id-123' \
  "$TEMP_DIR/consumer-oidc/.github/workflows/octestra-orchestrator.yml"

mkdir -p "$TEMP_DIR/archive/octestra-main" "$TEMP_DIR/consumer-piped"
cp -R "$ROOT/templates" "$TEMP_DIR/archive/octestra-main/templates"
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
test -f "$TEMP_DIR/consumer-piped/.github/workflows/octestra-orchestrator.yml"
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
grep -q 'OCTESTRA_GITHUB_APP_CLIENT_ID:.*replacement-client-id' "$orchestrator"

printf 'Installer tests passed\n'
