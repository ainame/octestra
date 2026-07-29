#!/usr/bin/env bash

# Octestra maintenance CLI for this repository.
#
#   .github/octestra/octestra.sh doctor       diagnose this installation
#   .github/octestra/octestra.sh vars check   compare config.yml with repository variables
#   .github/octestra/octestra.sh vars sync    write config.yml values to repository variables
#   .github/octestra/octestra.sh ref          show which Octestra the workflows call
#   .github/octestra/octestra.sh ref SPEC     call OWNER/REPO@REF, @REF, OWNER/REPO, or --latest
#
# Requires the GitHub CLI, authenticated with 'gh auth login'. 'doctor' and 'vars check'
# only read; 'vars sync' writes this repository's Actions variables, and 'ref' edits the
# workflow files in this checkout. Neither reads or writes a secret value.
#
# install.sh overwrites this file on every run, so keep repository policy in config.yml
# beside it rather than here.

set -euo pipefail

readonly API_VERSION="2026-03-10"
readonly CONFIG_PATH=".github/octestra/config.yml"
readonly ENTRY_WORKFLOW=".github/workflows/octestra-lifecycle.yml"
readonly PRIVATE_KEY_SECRET="OCTESTRA_GITHUB_APP_PRIVATE_KEY"
readonly CLIENT_ID_PLACEHOLDER="YOUR-GITHUB-APP-CLIENT-ID"
# The values Octestra needs before a job starts, as variable|section|key. A workflow reads
# these from repository variables because no file can be read that early, which is why they
# can drift from config.yml at all.
readonly MIRRORED_VARIABLES=(
  "OCTESTRA_GITHUB_APP_CLIENT_ID|github_app|client_id"
  "OCTESTRA_ORCHESTRATION_RUNNER|runners|orchestration"
  "OCTESTRA_AGENT_RUNNER|runners|agent"
  "OCTESTRA_STATUS_FIELD_ID|status|field_id"
)
# The statuses the lifecycle state graph moves a task through. Octestra addresses a status
# option by its display name, so renaming one in the organization breaks this installation:
# doctor reports it here instead of leaving a transition to fail mid-workflow.
readonly REQUIRED_STATUS_OPTIONS=(
  "Todo"
  "Ready"
  "In Progress"
  "Validation"
  "Human Review"
  "Blocked"
  "Done"
)
# The Octestra action the workflows beside this script call. install.sh rewrites this line
# together with every workflow reference, and so does 'ref', so it always names the same
# action the workflows do.
readonly INSTALLED_ACTION="ainame/octestra@main"

FAILURES=0
WARNINGS=0
REPOSITORY=""
ORGANIZATION=""

usage() {
  cat <<'EOF'
Diagnose and maintain the Octestra installation in this repository.

Usage:
  .github/octestra/octestra.sh [COMMAND]

Commands:
  doctor          Report every problem this installation has (default)
  vars check      Exit non-zero when a repository variable disagrees with config.yml
  vars sync       Write the config.yml values into this repository's variables
  ref             Show which Octestra repository and ref the workflows call
  ref SPEC        Change it. SPEC is OWNER/REPO@REF, @REF, OWNER/REPO, or --latest
  help            Show this help
EOF
}

info() {
  printf 'Octestra: %s\n' "$*"
}

die() {
  printf 'Octestra: error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required"
}

# Every path this script handles is repository-relative, so it can be run from anywhere.
enter_repository_root() {
  local script_dir=""

  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  cd "$script_dir/../.." || die "could not resolve the repository root"
}

resolve_repository() {
  local slug=""

  slug=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
  [[ -n "$slug" ]] ||
    die "could not determine this repository; authenticate with 'gh auth login'"
  REPOSITORY="$slug"
  ORGANIZATION="${slug%%/*}"
}

# Reads one scalar from config.yml without a YAML parser, so this script needs nothing but
# the GitHub CLI. It resolves `section: { key: value }` at the two indent levels config.yml
# uses, drops a trailing comment, and returns non-zero when the key is absent.
config_scalar() {
  local section="$1"
  local key="$2"
  local in_section=false
  local line=""
  local value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$section":*)
        in_section=true
        continue
        ;;
    esac
    if [[ "$in_section" == false ]]; then
      continue
    fi
    if [[ "$line" == [^[:space:]]* ]]; then
      in_section=false
      continue
    fi
    if [[ "$line" == "  $key:"* ]]; then
      value=${line#*:}
      value=${value%%#*}
      value=${value#"${value%%[![:space:]]*}"}
      value=${value%"${value##*[![:space:]]}"}
      value=${value#\"}
      value=${value%\"}
      value=${value#\'}
      value=${value%\'}
      printf '%s' "$value"
      return 0
    fi
  done < "$CONFIG_PATH"
  return 1
}

report() {
  local level="$1"
  shift

  case "$level" in
    ok)
      printf '  ok    %s\n' "$*"
      ;;
    note)
      printf '  note  %s\n' "$*"
      ;;
    warn)
      printf '  warn  %s\n' "$*"
      WARNINGS=$((WARNINGS + 1))
      ;;
    fail)
      printf '  fail  %s\n' "$*"
      FAILURES=$((FAILURES + 1))
      ;;
  esac
}

check_config() {
  local before="$FAILURES"
  local entry=""
  local rest=""
  local client_id=""

  if [[ ! -f "$CONFIG_PATH" ]]; then
    report fail "$CONFIG_PATH is missing; rerun install.sh"
    return
  fi
  for entry in "${MIRRORED_VARIABLES[@]}"; do
    rest="${entry#*|}"
    if ! config_scalar "${rest%%|*}" "${rest##*|}" >/dev/null; then
      report fail "$CONFIG_PATH has no ${rest%%|*}.${rest##*|}"
    fi
  done
  for entry in "status|field_name" "branch|task" "prompts|lifecycle_in_progress" \
    "prompts|lifecycle_validation"; do
    if ! config_scalar "${entry%%|*}" "${entry##*|}" >/dev/null; then
      report fail "$CONFIG_PATH has no ${entry%%|*}.${entry##*|}"
    fi
  done
  client_id=$(config_scalar github_app client_id || true)
  if [[ "$client_id" == "$CLIENT_ID_PLACEHOLDER" ]]; then
    report warn \
      "github_app.client_id is still $CLIENT_ID_PLACEHOLDER, so no job can mint an App token"
  fi
  if (( FAILURES == before )); then
    report ok "$CONFIG_PATH declares every value Octestra reads"
  fi
}

# An unset variable is the dangerous case: it evaluates to the empty string, which casts to
# 0 in the entry point's numeric comparison and silently routes nothing.
check_variables() {
  local before="$FAILURES"
  local entry=""
  local name=""
  local rest=""
  local expected=""
  local actual=""

  if [[ ! -f "$CONFIG_PATH" ]]; then
    return
  fi
  for entry in "${MIRRORED_VARIABLES[@]}"; do
    name="${entry%%|*}"
    rest="${entry#*|}"
    expected=$(config_scalar "${rest%%|*}" "${rest##*|}") || continue
    actual=$(gh variable get "$name" 2>/dev/null || true)
    if [[ -z "$actual" ]]; then
      report fail "$name is unset; run 'octestra.sh vars sync'"
    elif [[ "$actual" != "$expected" ]]; then
      report fail \
        "$name is '$actual' but $CONFIG_PATH says '$expected'; run 'octestra.sh vars sync'"
    fi
  done
  if (( FAILURES == before )); then
    report ok "the four mirrored repository variables match $CONFIG_PATH"
  fi
}

# Checks that the secret exists by name only. Its value is never read.
check_private_key_secret() {
  local names=""

  names=$(
    gh api \
      -H "Accept: application/vnd.github+json" \
      "/repos/$REPOSITORY/actions/secrets" \
      --paginate \
      --jq '.secrets[].name' 2>/dev/null || true
  )
  if [[ -z "$names" ]]; then
    report warn \
      "could not list Actions secrets; repository admin access is needed to check $PRIVATE_KEY_SECRET"
    return
  fi
  if printf '%s\n' "$names" | grep -q -x "$PRIVATE_KEY_SECRET"; then
    report ok "$PRIVATE_KEY_SECRET is set"
  else
    report fail "$PRIVATE_KEY_SECRET is not set; no job can mint an App token"
  fi
}

# Two different failures live here. Operations look the field up by *name*, so a rename
# makes every status update fail; the entry point routes on the field *ID*, so a stale ID
# means no workflow ever starts. Both must point at one field.
check_status_field() {
  local before="$FAILURES"
  local field_name=""
  local field_id=""
  local id=""
  local data_type=""
  local name=""
  local named_id=""
  local named_type=""
  local id_name=""

  if [[ ! -f "$CONFIG_PATH" ]]; then
    return
  fi
  field_name=$(config_scalar status field_name) || return
  field_id=$(config_scalar status field_id) || return

  while IFS=$'\t' read -r id data_type name; do
    if [[ "$id" == "$field_id" ]]; then
      id_name="$name"
    fi
    if [[ "$name" == "$field_name" ]]; then
      named_id="$id"
      named_type="$data_type"
    fi
  done < <(
    gh api \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      "/orgs/$ORGANIZATION/issue-fields" \
      --paginate \
      --jq '.[] | [.id, .data_type, .name] | @tsv' 2>/dev/null || true
  )

  if [[ -z "$named_id" ]]; then
    report fail \
      "no Issue Field in '$ORGANIZATION' is named '$field_name'; every status update looks it up by name"
  elif [[ "$named_type" != "single_select" ]]; then
    report fail "Issue Field '$field_name' is $named_type, not single_select"
  fi
  if [[ -z "$id_name" ]]; then
    report fail \
      "no Issue Field in '$ORGANIZATION' has id $field_id; the entry point compares this ID before any job starts, so nothing routes"
  elif [[ -n "$named_id" && "$named_id" != "$field_id" ]]; then
    report fail \
      "status.field_name resolves to field $named_id but status.field_id is $field_id; routing and operations would use different fields"
  fi
  if [[ -n "$named_id" ]]; then
    check_status_options "$named_id" "$field_name"
  fi
  if (( FAILURES == before )); then
    report ok "Issue Field '$field_name' ($field_id) has all seven status options"
  fi
}

check_status_options() {
  local field="$1"
  local field_name="$2"
  local present=""
  local option=""
  local name=""
  local missing=()

  while IFS= read -r name; do
    present+="|$name|"
  done < <(
    gh api \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      "/orgs/$ORGANIZATION/issue-fields" \
      --paginate \
      --jq ".[] | select(.id == $field) | (.options // .single_select_options // [])[] | .name" \
      2>/dev/null || true
  )
  for option in "${REQUIRED_STATUS_OPTIONS[@]}"; do
    if [[ "$present" != *"|$option|"* ]]; then
      missing+=("$option")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    report fail \
      "Issue Field '$field_name' is missing the status options: ${missing[*]}; rerun install.sh to print the command that adds them"
  fi
}

check_workflows() {
  local before="$FAILURES"
  local action_repository="${INSTALLED_ACTION%@*}"
  local installed_ref="${INSTALLED_ACTION##*@}"
  local called=""
  local refs=""
  local tag=""

  if [[ ! -f "$ENTRY_WORKFLOW" ]]; then
    report fail "$ENTRY_WORKFLOW is missing; rerun install.sh"
    return
  fi
  # A status job whose reusable workflow is absent fails the whole run at startup, with no
  # jobs and no logs, so an enabled-but-missing callee is worth catching here.
  while IFS= read -r called; do
    if [[ ! -f "$called" ]]; then
      report fail "a workflow calls $called, which does not exist"
    fi
  done < <(
    grep -h -o -E '^[^#]*uses: \./[^[:space:]]+' .github/workflows/octestra-*.yml |
      sed -E 's|.*uses: \./||' |
      sort -u
  )
  # No match means the workflows call some other Octestra, which is a finding rather than an
  # error: without '|| true' the failed grep would abort this script under 'set -o pipefail'.
  refs=$(
    grep -h -o -E "^[^#]*uses: $action_repository(/[^@[:space:]]+)?@[^[:space:]]+" \
      .github/workflows/octestra-*.yml |
      sed -E 's|.*@||' |
      sort -u || true
  )
  if [[ -z "$refs" ]]; then
    report fail \
      "no workflow calls $action_repository; this script and the workflows disagree about which Octestra runs"
  elif [[ $(printf '%s\n' "$refs" | wc -l | tr -d ' ') != "1" ]]; then
    report fail \
      "workflows call $action_repository at more than one ref: $(printf '%s' "$refs" | tr '\n' ' ')"
  elif [[ "$refs" != "$installed_ref" ]]; then
    report fail \
      "workflows call $action_repository@$refs but this script records @$installed_ref; rerun install.sh or 'octestra.sh ref'"
  else
    report ok "workflows call $INSTALLED_ACTION"
    tag=$(latest_version_tag "$action_repository") || true
    if [[ -n "$tag" && "$tag" != "$installed_ref" ]]; then
      report note \
        "$action_repository has a newer tag $tag; switch with 'octestra.sh ref --latest'"
    fi
  fi
  if (( FAILURES == before )); then
    report ok "every reusable workflow an enabled status job calls exists"
  fi
}

check_prompts() {
  local before="$FAILURES"
  local key=""
  local path=""

  if [[ ! -f "$CONFIG_PATH" ]]; then
    return
  fi
  for key in lifecycle_in_progress lifecycle_validation; do
    path=$(config_scalar prompts "$key") || continue
    if [[ ! -f "$path" ]]; then
      report fail "prompts.$key points at $path, which is not in this checkout"
    fi
  done
  if (( FAILURES == before )); then
    report ok "both lifecycle prompts are in this checkout"
  fi
}

doctor_command() {
  printf 'Octestra doctor: %s\n' "$REPOSITORY"
  check_config
  check_variables
  check_private_key_secret
  check_status_field
  check_workflows
  check_prompts
  if (( FAILURES > 0 )); then
    printf 'Octestra: %d problem(s), %d warning(s)\n' "$FAILURES" "$WARNINGS" >&2
    exit 1
  fi
  info "no problems found, $WARNINGS warning(s)"
}

vars_command() {
  local mode="${1:-check}"
  local entry=""
  local name=""
  local rest=""
  local expected=""
  local actual=""
  local status=0

  case "$mode" in
    check|sync) ;;
    *) die "vars takes 'check' or 'sync', not '$mode'" ;;
  esac
  [[ -f "$CONFIG_PATH" ]] || die "$CONFIG_PATH not found; run install.sh first"

  for entry in "${MIRRORED_VARIABLES[@]}"; do
    name="${entry%%|*}"
    rest="${entry#*|}"
    expected=$(config_scalar "${rest%%|*}" "${rest##*|}") ||
      die "$CONFIG_PATH has no ${rest%%|*}.${rest##*|}"
    if [[ "$mode" == "sync" ]]; then
      info "setting $name to '$expected' in $REPOSITORY"
      gh variable set "$name" --body "$expected"
      continue
    fi
    actual=$(gh variable get "$name" 2>/dev/null || true)
    if [[ "$actual" != "$expected" ]]; then
      printf "Octestra: %s drifted: variable '%s', %s '%s'\n" \
        "$name" "$actual" "$CONFIG_PATH" "$expected" >&2
      status=1
    fi
  done
  return "$status"
}

# Newest version tag in a repository, by version sort. Tags that are not plain versions are
# ignored, so a release candidate is never offered. An unreachable, private, or untagged
# repository yields an empty string.
latest_version_tag() {
  local repository="$1"

  gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/$repository/tags" \
    --paginate \
    --jq '.[].name' 2>/dev/null |
    grep -E '^v?[0-9]+(\.[0-9]+)*$' |
    sort -V |
    tail -n 1
}

ref_command() {
  local spec="${1-}"
  local repository="${INSTALLED_ACTION%@*}"
  local current_ref="${INSTALLED_ACTION##*@}"
  local target=""
  local tag=""

  if [[ -z "$spec" ]]; then
    printf '%s\n' "$INSTALLED_ACTION"
    tag=$(latest_version_tag "$repository") || true
    if [[ -n "$tag" && "$tag" != "$current_ref" ]]; then
      info "newest tag in $repository is $tag; switch with 'octestra.sh ref --latest'"
    fi
    return
  fi

  case "$spec" in
    --latest)
      tag=$(latest_version_tag "$repository") || true
      [[ -n "$tag" ]] || die "$repository has no version tags"
      target="$repository@$tag"
      ;;
    @*)
      target="$repository$spec"
      ;;
    */*@*)
      target="$spec"
      ;;
    */*)
      target="$spec@$current_ref"
      info "keeping the current ref: $target"
      ;;
    *)
      die "ref takes OWNER/REPO@REF, @REF, OWNER/REPO, or --latest, not '$spec'"
      ;;
  esac

  [[ "${target%@*}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] ||
    die "repository must be OWNER/REPO: ${target%@*}"
  [[ "${target##*@}" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    die "ref must be a git ref: ${target##*@}"
  if [[ "$target" == "$INSTALLED_ACTION" ]]; then
    info "already calling $target"
    return
  fi

  rewrite_action_reference "$INSTALLED_ACTION" "$target"
  info "switched from $INSTALLED_ACTION to $target"
  info "review and commit .github to put the change into effect"
}

# Repoints every reference to the currently installed action, including the one recorded in
# this script, so the two never disagree. Each file is rewritten through a temporary file
# and renamed into place, which is also what makes rewriting this running script safe.
rewrite_action_reference() {
  local from="$1"
  local to="$2"
  local pattern="${from%@*}(/[^@[:space:]]+)?@${from##*@}"
  local replacement="${to%@*}\\1@${to##*@}"
  local file=""
  local output=""

  while IFS= read -r file; do
    output="$file.octestra-tmp"
    sed -E "s|$pattern|$replacement|g" "$file" > "$output"
    if [[ -x "$file" ]]; then
      chmod +x "$output"
    fi
    mv "$output" "$file"
  done < <(find .github/workflows .github/octestra -type f -print)

  if grep -R -E -q "$pattern" .github/workflows .github/octestra; then
    die "some references to $from were not rewritten"
  fi
}

main() {
  local command="${1:-doctor}"

  require_command gh
  enter_repository_root
  if (( $# > 0 )); then
    shift
  fi

  case "$command" in
    doctor)
      resolve_repository
      doctor_command
      ;;
    vars)
      resolve_repository
      vars_command "$@"
      ;;
    ref)
      ref_command "$@"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
