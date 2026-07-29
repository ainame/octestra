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
  # The maintenance script asks for the slug; only the installer's owner inference is what
  # OCTESTRA_TEST_REPO_VIEW_FAIL forces onto its git-remote fallback.
  if [[ "$*" == *nameWithOwner* ]]; then
    printf 'example-org/consumer\n'
    exit 0
  fi
  if [[ "${OCTESTRA_TEST_REPO_VIEW_FAIL:-false}" == "true" ]]; then
    exit 1
  fi
  printf 'example-org\n'
  exit 0
fi

if [[ "$1 $2" == "variable set" ]]; then
  printf '%s=%s\n' "$3" "$5" >> "${OCTESTRA_TEST_VARS_LOG:-/dev/null}"
  exit 0
fi

if [[ "$1 $2" == "variable get" ]]; then
  for entry in ${OCTESTRA_TEST_VARS:-}; do
    if [[ "${entry%%=*}" == "$3" ]]; then
      printf '%s\n' "${entry#*=}"
      exit 0
    fi
  done
  exit 1
fi

if [[ "$1" != "api" ]]; then
  exit 1
fi

args="$*"
if [[ "$args" == *"/actions/secrets"* ]]; then
  if [[ -z "${OCTESTRA_TEST_SECRETS:-}" ]]; then
    exit 1
  fi
  for secret in ${OCTESTRA_TEST_SECRETS}; do
    printf '%s\n' "$secret"
  done
  exit 0
fi

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

# The maintenance script reads id, data_type, name; the installer reads id, name,
# data_type. Both are answered from the same simulated organization field.
if [[ "$args" == *"[.id, .data_type, .name]"* ]]; then
  printf '%s\t%s\t%s\n' \
    "${OCTESTRA_TEST_FIELD_ID:-9001}" \
    "${OCTESTRA_TEST_FIELD_DATA_TYPE:-single_select}" \
    "${OCTESTRA_TEST_FIELD_NAME:-AI Task Status}"
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

# An upstream install pins the newest plain version tag: 1.10 outranks 1.9, a release
# candidate is not a plain version, and the moving major tag that release.yml force-pushes
# beside each release loses to the exact version it points at.
mkdir -p "$TEMP_DIR/consumer-tagged"
git -C "$TEMP_DIR/consumer-tagged" init --quiet
git -C "$TEMP_DIR/consumer-tagged" remote add origin git@github.com:example-org/consumer-tagged.git
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  OCTESTRA_TEST_TAGS="v1 v1.9.0 v1.10.0 v1.11.0-rc1 nightly" \
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

# config.yml is the consumer's control plane, so a rerun keeps the file they have: rendering
# the template again would reset the runners, branch template and prompt paths they chose. The
# installer says so, including for a value it was asked to write.
rerun_output="$TEMP_DIR/rerun-output"
printf 'runners:\n  orchestration: macos-15\n' >>"$TEMP_DIR/consumer/.github/octestra/config.yml"
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
    --yes >"$rerun_output"
grep -q 'orchestration: macos-15' "$TEMP_DIR/consumer/.github/octestra/config.yml"
grep -q 'kept the existing config.yml' "$rerun_output"
grep -q 'config.yml keeps its own github_app.client_id' "$rerun_output"
if grep -q 'client_id: "replacement-client-id"' \
  "$TEMP_DIR/consumer/.github/octestra/config.yml"; then
  echo "a rerun rewrote the consumer's config.yml" >&2
  exit 1
fi

test -f "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-in-progress.yml"
test -f "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-validation.yml"
grep -q 'operation: lifecycle/prepare-task' "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-in-progress.yml"
grep -q 'operation: lifecycle/prepare-validation' "$TEMP_DIR/consumer/.github/workflows/octestra-lifecycle-validation.yml"
grep -q 'owner: \${{ github.repository_owner }}' "$orchestrator"
grep -q 'repositories: \${{ github.repository }}' "$orchestrator"
for variable in OCTESTRA_GITHUB_APP_CLIENT_ID OCTESTRA_ORCHESTRATION_RUNNER OCTESTRA_AGENT_RUNNER OCTESTRA_STATUS_FIELD_ID; do
  grep -q "$variable" "$ROOT/templates/.github/octestra/octestra.sh"
done

# install.sh creates the Issue Field and the installed script diagnoses it, so both carry
# the status vocabulary. They must carry the same one: a status is addressed by display
# name, and a list that drifts would report a problem that is not there or miss one.
installer_options=$(
  sed -n '/^readonly REQUIRED_OPTIONS=(/,/^)/p' "$ROOT/install.sh" |
    sed -n 's/^  "\([^|]*\)|.*/\1/p'
)
script_options=$(
  sed -n '/^readonly REQUIRED_STATUS_OPTIONS=(/,/^)/p' \
    "$ROOT/templates/.github/octestra/octestra.sh" |
    sed -n 's/^  "\(.*\)"$/\1/p'
)
test "$(printf '%s\n' "$installer_options" | wc -l | tr -d ' ')" = "7"
if [[ "$installer_options" != "$script_options" ]]; then
  echo "install.sh and octestra.sh disagree about the required status options" >&2
  diff <(printf '%s\n' "$installer_options") <(printf '%s\n' "$script_options") >&2 || true
  exit 1
fi

printf 'Installer tests passed\n'

# ---------------------------------------------------------------------------
# The maintenance script install.sh leaves in the consumer repository.
# ---------------------------------------------------------------------------
maintenance="$TEMP_DIR/consumer-doctor/.github/octestra/octestra.sh"
vars_log="$TEMP_DIR/vars-log"
clean_vars="OCTESTRA_GITHUB_APP_CLIENT_ID=doctor-client-id"
clean_vars+=" OCTESTRA_ORCHESTRATION_RUNNER=ubuntu-latest"
clean_vars+=" OCTESTRA_AGENT_RUNNER=ubuntu-latest"
clean_vars+=" OCTESTRA_STATUS_FIELD_ID=9001"

mkdir -p "$TEMP_DIR/consumer-doctor"
git -C "$TEMP_DIR/consumer-doctor" init --quiet
git -C "$TEMP_DIR/consumer-doctor" remote add origin git@github.com:example-org/consumer-doctor.git
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
  OCTESTRA_TEST_REPO_VIEW_FAIL=true \
  OCTESTRA_TEST_VARS_LOG="$vars_log" \
  bash "$ROOT/install.sh" \
    --org example-org \
    --status-field "AI Task Status" \
    --target "$TEMP_DIR/consumer-doctor" \
    --source-dir "$ROOT" \
    --skill-target claude \
    --github-app-client-id doctor-client-id \
    --yes >/dev/null
test -x "$maintenance"
# install.sh mirrors through the script it just installed, so this log is evidence that the
# tool a consumer will use for every later sync works.
grep -q '^OCTESTRA_GITHUB_APP_CLIENT_ID=doctor-client-id$' "$vars_log"
grep -q '^OCTESTRA_ORCHESTRATION_RUNNER=ubuntu-latest$' "$vars_log"
grep -q '^OCTESTRA_AGENT_RUNNER=ubuntu-latest$' "$vars_log"
grep -q '^OCTESTRA_STATUS_FIELD_ID=9001$' "$vars_log"

PATH="$TEMP_DIR/bin:$PATH" OCTESTRA_TEST_VARS="$clean_vars" bash "$maintenance" vars check

drift_output="$TEMP_DIR/drift-output"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_VARS="${clean_vars/AGENT_RUNNER=ubuntu-latest/AGENT_RUNNER=macos-15}" \
    bash "$maintenance" vars check >"$drift_output" 2>&1; then
  echo "vars check accepted a drifted variable" >&2
  exit 1
fi
grep -q "OCTESTRA_AGENT_RUNNER drifted" "$drift_output"

doctor_output="$TEMP_DIR/doctor-output"
PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_VARS="$clean_vars" \
  OCTESTRA_TEST_SECRETS="OCTESTRA_GITHUB_APP_PRIVATE_KEY" \
    bash "$maintenance" doctor >"$doctor_output"
grep -q 'no problems found' "$doctor_output"
grep -q 'workflows call ainame/octestra@main' "$doctor_output"
if grep -q '  fail' "$doctor_output"; then
  echo "doctor reported a failure for a healthy installation" >&2
  cat "$doctor_output" >&2
  exit 1
fi

# Each break doctor exists to name: an unset variable routes nothing (P3), a missing
# private key stops every job, and a renamed field breaks every operation that looks the
# field up by name (P1).
broken_output="$TEMP_DIR/doctor-broken-output"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_SECRETS="SOME_OTHER_SECRET" \
  OCTESTRA_TEST_FIELD_NAME="Renamed Status" \
    bash "$maintenance" doctor >"$broken_output" 2>&1; then
  echo "doctor reported success for a broken installation" >&2
  exit 1
fi
grep -q "OCTESTRA_STATUS_FIELD_ID is unset" "$broken_output"
grep -q "OCTESTRA_GITHUB_APP_PRIVATE_KEY is not set" "$broken_output"
grep -q "is named 'AI Task Status'" "$broken_output"

# An enabled status job whose reusable workflow is absent fails a run at startup with no
# logs, so doctor reports the missing file instead.
mv "$TEMP_DIR/consumer-doctor/.github/workflows/octestra-lifecycle-validation.yml" \
  "$TEMP_DIR/parked-validation.yml"
missing_callee_output="$TEMP_DIR/doctor-missing-callee-output"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_VARS="$clean_vars" \
  OCTESTRA_TEST_SECRETS="OCTESTRA_GITHUB_APP_PRIVATE_KEY" \
    bash "$maintenance" doctor >"$missing_callee_output" 2>&1; then
  echo "doctor accepted a status job with no reusable workflow" >&2
  exit 1
fi
grep -q "octestra-lifecycle-validation.yml, which does not exist" "$missing_callee_output"
mv "$TEMP_DIR/parked-validation.yml" \
  "$TEMP_DIR/consumer-doctor/.github/workflows/octestra-lifecycle-validation.yml"

# ref reports what the workflows call, and switching rewrites the workflows and the script
# itself, so the two cannot disagree afterwards.
test "$(PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref)" = "ainame/octestra@main"
PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref @v2.0.0 >/dev/null
test "$(PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref)" = "ainame/octestra@v2.0.0"
test -x "$maintenance"
grep -q 'uses: ainame/octestra@v2\.0\.0' \
  "$TEMP_DIR/consumer-doctor/.github/workflows/octestra-lifecycle.yml"
if grep -R 'ainame/octestra@main' "$TEMP_DIR/consumer-doctor/.github" >/dev/null; then
  echo "ref left a reference on the previous ref" >&2
  exit 1
fi

PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref example-org/octestra@main >/dev/null
test "$(PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref)" = "example-org/octestra@main"
switched_references=$(count_references 'example-org/octestra@main' \
  "$TEMP_DIR/consumer-doctor/.github")
if [[ "$switched_references" != "$template_references" ]]; then
  echo "ref rewrote $switched_references of $template_references references" >&2
  exit 1
fi

PATH="$TEMP_DIR/bin:$PATH" OCTESTRA_TEST_TAGS="v1.9.0 v1.10.0" \
  bash "$maintenance" ref --latest >/dev/null
test "$(PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref)" = "example-org/octestra@v1.10.0"

# Workflows that call a different Octestra than the script records — a hand edit on one side
# — are a finding doctor must name rather than an error it dies on.
for workflow in "$TEMP_DIR/consumer-doctor"/.github/workflows/octestra-*.yml; do
  sed 's|example-org/octestra@v1\.10\.0|other-org/octestra@main|g' "$workflow" > "$workflow.new"
  mv "$workflow.new" "$workflow"
done
mismatch_output="$TEMP_DIR/doctor-mismatch-output"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_VARS="$clean_vars" \
  OCTESTRA_TEST_SECRETS="OCTESTRA_GITHUB_APP_PRIVATE_KEY" \
    bash "$maintenance" doctor >"$mismatch_output" 2>&1; then
  echo "doctor accepted workflows that call a different Octestra" >&2
  exit 1
fi
grep -q "no workflow calls example-org/octestra" "$mismatch_output"

malformed_ref_output="$TEMP_DIR/malformed-ref-output"
if PATH="$TEMP_DIR/bin:$PATH" bash "$maintenance" ref '@main|sed-injection' \
  >"$malformed_ref_output" 2>&1; then
  echo "ref accepted a malformed ref" >&2
  exit 1
fi
grep -q "must be a git ref" "$malformed_ref_output"

printf 'Maintenance script tests passed\n'

# ---------------------------------------------------------------------------
# Updating an installation: marked custom regions survive, everything else does not.
# ---------------------------------------------------------------------------
new_consumer() {
  local target="$1"

  mkdir -p "$target"
  git -C "$target" init --quiet
  git -C "$target" remote add origin "git@github.com:example-org/$(basename "$target").git"
}

install_into() {
  local target="$1"
  shift

  PATH="$TEMP_DIR/bin:$PATH" \
    OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
    OCTESTRA_TEST_REPO_VIEW_FAIL=true \
      bash "$ROOT/install.sh" \
        --org example-org \
        --status-field "AI Task Status" \
        --target "$target" \
        --source-dir "$ROOT" \
        --skill-target codex \
        --github-app-client-id update-client-id \
        --yes "$@"
}

# Replaces the body of one custom region, the way a consumer editing the file would.
customize_region() {
  local file="$1"
  local region="$2"
  local content="$3"
  local output="$file.customized"
  local line=""
  local inside=false

  : > "$output"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *"octestra:custom:begin $region" ]]; then
      printf '%s\n%s\n' "$line" "$content" >> "$output"
      inside=true
      continue
    fi
    if [[ "$line" == *"octestra:custom:end $region" ]]; then
      inside=false
    fi
    if [[ "$inside" == true ]]; then
      continue
    fi
    printf '%s\n' "$line" >> "$output"
  done < "$file"
  mv "$output" "$file"
}

parses_as_yaml() {
  node -e 'require("yaml").parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1"
}

update_dir="$TEMP_DIR/consumer-update"
update_entry="$update_dir/.github/workflows/octestra-lifecycle.yml"
update_in_progress="$update_dir/.github/workflows/octestra-lifecycle-in-progress.yml"
new_consumer "$update_dir"
install_into "$update_dir" >/dev/null

customize_region "$update_in_progress" agent-steps "      - name: Run the repository agent
        run: ./scripts/agent.sh"
customize_region "$update_in_progress" agent-credentials "      your_agent_api_key:
        description: API key for the task agent
        required: true"
customize_region "$update_entry" in-progress-secrets \
  '      your_agent_api_key: ${{ secrets.YOUR_AGENT_API_KEY }}'
customize_region "$update_entry" status-jobs "  todo:
    needs: guard
    if: needs.guard.outputs.valid == 'true' && needs.guard.outputs.status_key == 'todo'
    uses: ./.github/workflows/octestra-lifecycle-todo.yml"
# A managed line the consumer also changed, to prove Octestra's own content is restored.
sed 's/timeout-minutes: 60/timeout-minutes: 5/' "$update_in_progress" >"$update_in_progress.edit"
mv "$update_in_progress.edit" "$update_in_progress"

install_into "$update_dir" >/dev/null
grep -q 'run: ./scripts/agent.sh' "$update_in_progress"
grep -q 'description: API key for the task agent' "$update_in_progress"
grep -q 'your_agent_api_key: \${{ secrets.YOUR_AGENT_API_KEY }}' "$update_entry"
grep -q '^  todo:$' "$update_entry"
grep -q 'timeout-minutes: 60' "$update_in_progress"
if grep -q "Replace this step with the repository's task agent configuration" \
  "$update_in_progress"; then
  echo "the update restored the placeholder agent step over the consumer's own" >&2
  exit 1
fi
# Anywhere under .github, not only the workflows: the maintenance script mentions the marker
# prefix in a constant without declaring a region, and must not be mistaken for one.
if [[ -n "$(find "$update_dir/.github" -name "*.octestra-bak" -print)" ]]; then
  echo "a mergeable update still left a backup:" >&2
  find "$update_dir/.github" -name "*.octestra-bak" -print >&2
  exit 1
fi
parses_as_yaml "$update_in_progress"
parses_as_yaml "$update_entry"

# Reinstalling over a merged file must be a no-op, or every update would churn the diff.
before_rerun=$(cat "$update_in_progress" "$update_entry")
install_into "$update_dir" >/dev/null
if [[ "$before_rerun" != "$(cat "$update_in_progress" "$update_entry")" ]]; then
  echo "a second identical install changed the merged workflows" >&2
  exit 1
fi

# An installation from before custom regions existed cannot be merged. The file is replaced
# and the previous one kept beside it, because dropping it would discard the agent wiring.
legacy_dir="$TEMP_DIR/consumer-legacy"
legacy_in_progress="$legacy_dir/.github/workflows/octestra-lifecycle-in-progress.yml"
new_consumer "$legacy_dir"
install_into "$legacy_dir" >/dev/null
customize_region "$legacy_in_progress" agent-steps "      - name: Run the repository agent
        run: ./scripts/legacy-agent.sh"
grep -v 'octestra:custom:' "$legacy_in_progress" >"$legacy_in_progress.edit"
mv "$legacy_in_progress.edit" "$legacy_in_progress"
legacy_output="$TEMP_DIR/legacy-install-output"
install_into "$legacy_dir" >"$legacy_output"
grep -q 'has no # octestra:custom: markers' "$legacy_output"
test -f "$legacy_in_progress.octestra-bak"
grep -q 'run: ./scripts/legacy-agent.sh' "$legacy_in_progress.octestra-bak"
grep -q 'octestra:custom:begin agent-steps' "$legacy_in_progress"
if grep -q 'run: ./scripts/legacy-agent.sh' "$legacy_in_progress"; then
  echo "an unmergeable file was silently kept instead of replaced" >&2
  exit 1
fi

# A region the new version no longer has: carry over what still matches, keep a copy of the
# rest, and let the new region's own body through.
orphan_dir="$TEMP_DIR/consumer-orphan"
orphan_in_progress="$orphan_dir/.github/workflows/octestra-lifecycle-in-progress.yml"
new_consumer "$orphan_dir"
install_into "$orphan_dir" >/dev/null
customize_region "$orphan_in_progress" agent-steps "      - name: Run the repository agent
        run: ./scripts/orphan-agent.sh"
customize_region "$orphan_in_progress" agent-credentials "      kept_api_key:
        required: true"
sed 's/agent-steps/legacy-agent-steps/g' "$orphan_in_progress" >"$orphan_in_progress.edit"
mv "$orphan_in_progress.edit" "$orphan_in_progress"
orphan_output="$TEMP_DIR/orphan-install-output"
install_into "$orphan_dir" >"$orphan_output"
grep -q 'has no custom region named legacy-agent-steps' "$orphan_output"
test -f "$orphan_in_progress.octestra-bak"
grep -q 'kept_api_key:' "$orphan_in_progress"
grep -q "Replace this step with the repository's task agent configuration" \
  "$orphan_in_progress"
grep -q 'run: ./scripts/orphan-agent.sh' "$orphan_in_progress.octestra-bak"
parses_as_yaml "$orphan_in_progress"

# doctor reports markers a hand edit broke, before the next install acts on them.
broken_regions_output="$TEMP_DIR/doctor-broken-regions-output"
grep -v 'octestra:custom:end agent-steps' "$update_in_progress" >"$update_in_progress.edit"
mv "$update_in_progress.edit" "$update_in_progress"
if PATH="$TEMP_DIR/bin:$PATH" \
  OCTESTRA_TEST_VARS="OCTESTRA_GITHUB_APP_CLIENT_ID=update-client-id OCTESTRA_ORCHESTRATION_RUNNER=ubuntu-latest OCTESTRA_AGENT_RUNNER=ubuntu-latest OCTESTRA_STATUS_FIELD_ID=9001" \
  OCTESTRA_TEST_SECRETS="OCTESTRA_GITHUB_APP_PRIVATE_KEY" \
    bash "$update_dir/.github/octestra/octestra.sh" doctor >"$broken_regions_output" 2>&1; then
  echo "doctor accepted unbalanced custom region markers" >&2
  exit 1
fi
grep -q 'unbalanced custom region markers' "$broken_regions_output"

# An install must refuse to guess at those markers rather than drop the region's contents.
unbalanced_output="$TEMP_DIR/unbalanced-install-output"
if install_into "$update_dir" >"$unbalanced_output" 2>&1; then
  echo "the installer merged a file with unbalanced markers" >&2
  exit 1
fi
grep -q 'never ends custom region' "$unbalanced_output"

# ---------------------------------------------------------------------------
# octestra.sh update: the same merge, driven from the consumer's own repository.
# ---------------------------------------------------------------------------
mkdir -p "$TEMP_DIR/update-archive/octestra-main"
cp "$ROOT/install.sh" "$TEMP_DIR/update-archive/octestra-main/install.sh"
cp -R "$ROOT/templates" "$TEMP_DIR/update-archive/octestra-main/templates"
tar -czf "$TEMP_DIR/octestra-update.tar.gz" -C "$TEMP_DIR/update-archive" octestra-main

run_update() {
  local target="$1"
  local shell_binary="$2"
  shift 2

  PATH="$TEMP_DIR/bin:$PATH" \
    OCTESTRA_TEST_STATE="$TEMP_DIR/field-created" \
    OCTESTRA_TEST_ARCHIVE="$TEMP_DIR/octestra-update.tar.gz" \
    OCTESTRA_TEST_TARBALL_REF="$TEMP_DIR/update-tarball-ref" \
      "$shell_binary" "$target/.github/octestra/octestra.sh" update --yes "$@"
}

cli_dir="$TEMP_DIR/consumer-cli-update"
cli_entry="$cli_dir/.github/workflows/octestra-lifecycle.yml"
cli_in_progress="$cli_dir/.github/workflows/octestra-lifecycle-in-progress.yml"
cli_config="$cli_dir/.github/octestra/config.yml"
new_consumer "$cli_dir"
install_into "$cli_dir" --enable-oidc >/dev/null
customize_region "$cli_in_progress" agent-steps "      - name: Run the repository agent
        run: ./scripts/cli-agent.sh"
printf 'runners:\n  agent: macos-15\n' >>"$cli_config"
# Something Octestra owns, to prove the update really reinstalled it.
rm "$cli_dir/.github/octestra/prompts/lifecycle-validation.md.hbs"

cli_output="$TEMP_DIR/cli-update-output"
run_update "$cli_dir" bash >"$cli_output"
grep -q 'run: ./scripts/cli-agent.sh' "$cli_in_progress"
grep -q 'agent: macos-15' "$cli_config"
test -f "$cli_dir/.github/octestra/prompts/lifecycle-validation.md.hbs"
grep -q "updated to ainame/octestra@main" "$cli_output"
# OIDC lives on a line outside every custom region, so only an explicit flag preserves it.
if grep -q '^  # id-token: write$' "$cli_entry"; then
  echo "update reverted the OIDC permission" >&2
  exit 1
fi
grep -q '^  id-token: write$' "$cli_entry"

# A spec moves the installation to another ref, downloading that ref and rewriting every
# reference to it, including the one the maintenance script records.
run_update "$cli_dir" bash @v9.9.9 >/dev/null
grep -q '^v9\.9\.9$' "$TEMP_DIR/update-tarball-ref"
grep -q 'uses: ainame/octestra@v9\.9\.9' "$cli_entry"
test "$(PATH="$TEMP_DIR/bin:$PATH" bash "$cli_dir/.github/octestra/octestra.sh" ref)" = \
  "ainame/octestra@v9.9.9"
grep -q 'run: ./scripts/cli-agent.sh' "$cli_in_progress"

# install.sh and octestra.sh run on consumer machines, where /bin/bash may be 3.2. An empty
# array expanded under `set -u` is fatal there, so one update runs through it end to end.
if [[ -x /bin/bash ]]; then
  run_update "$cli_dir" /bin/bash >/dev/null
  grep -q 'run: ./scripts/cli-agent.sh' "$cli_in_progress"
fi

printf 'Workflow update tests passed\n'
