#!/usr/bin/env bash

# Octestra maintenance CLI for this repository.
#
#   .github/octestra/octestra.sh doctor       diagnose this installation
#   .github/octestra/octestra.sh update       install the latest stable release from the workflow's Octestra
#   .github/octestra/octestra.sh vars check   compare config.yml with repository variables
#   .github/octestra/octestra.sh vars sync    write config.yml values to repository variables
#   .github/octestra/octestra.sh ref          show which Octestra the workflow calls
#   .github/octestra/octestra.sh ref SPEC     call OWNER/REPO@REF, @REF, OWNER/REPO, or --latest
#
# Requires the GitHub CLI, authenticated with 'gh auth login'. 'doctor' and 'vars check'
# only read; 'vars sync' writes this repository's Actions variables, 'ref' edits the workflow
# files in this checkout, and 'update' replaces framework files and re-syncs those variables.
# No command reads or writes a secret value.
#
# install.sh overwrites this file on every run, so put anything you want to change in
# config.yml beside it, not here.

set -euo pipefail

readonly API_VERSION="2026-03-10"
readonly CONFIG_PATH=".github/octestra/config.yml"
readonly ENTRY_WORKFLOW=".github/workflows/octestra-lifecycle.yml"
readonly DEFAULT_PRIVATE_KEY_SECRET="OCTESTRA_GITHUB_APP_PRIVATE_KEY"
readonly CLIENT_ID_PLACEHOLDER="YOUR-GITHUB-APP-CLIENT-ID"
# The values Octestra needs before a job starts, as variable|section|key. A workflow reads
# these from repository variables because no file can be read that early, which is why they
# can disagree with config.yml at all.
readonly MIRRORED_VARIABLES=(
  "OCTESTRA_GITHUB_APP_CLIENT_ID|github_app|client_id|"
  "OCTESTRA_GITHUB_APP_PRIVATE_KEY_SECRET|github_app|private_key_secret_key_name|$DEFAULT_PRIVATE_KEY_SECRET"
  "OCTESTRA_ORCHESTRATION_RUNNER|runners|orchestration|"
  "OCTESTRA_AGENT_RUNNER|runners|agent|"
  "OCTESTRA_STATUS_FIELD_ID|status|field_id|"
)
# The statuses a task moves through. Octestra sets a status by its display name, so renaming
# one in the organization breaks this installation: doctor reports it here instead of letting
# a status change fail mid-workflow.
readonly REQUIRED_STATUS_OPTIONS=(
  "Todo"
  "Ready"
  "In Progress"
  "Validation"
  "Human Review"
  "Blocked"
  "Done"
)
# The Octestra action the workflow beside this script calls. install.sh rewrites this line
# together with every workflow reference, and so does 'ref', so it always names the same
# action the workflow does.
readonly INSTALLED_ACTION="ainame/octestra@main"

FAILURES=0
WARNINGS=0
REPOSITORY=""
ORGANIZATION=""
TEMP_DIR=""

usage() {
  cat <<'EOF'
Diagnose and maintain the Octestra installation in this repository.

Usage:
  .github/octestra/octestra.sh [COMMAND]

Commands:
  doctor          Report every problem this installation has (default)
  update [SPEC]   Install the latest stable release from the Octestra the workflow
                  calls, or install from SPEC (OWNER/REPO@REF, @REF, OWNER/REPO, or
                  --latest). Keeps config.yml, local agent actions, and prompts
  vars check      Exit non-zero when a repository variable disagrees with config.yml
  vars sync       Write the config.yml values into this repository's variables
  ref             Show which Octestra repository and ref the workflow calls
  ref SPEC        Change it. SPEC is OWNER/REPO@REF, @REF, OWNER/REPO, or --latest
  help            Show this help

Options:
  --yes           Do not ask before update replaces framework files
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

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}

has_interactive_tty() {
  [[ ( -t 0 || -t 1 ) && -r /dev/tty && -w /dev/tty ]]
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

mirrored_value() {
  local entry="$1"
  local rest="${entry#*|}"
  local section="${rest%%|*}"
  local key=""
  local fallback=""
  local value=""

  rest=${rest#*|}
  key=${rest%%|*}
  fallback=${rest#*|}
  value=$(config_scalar "$section" "$key" || true)
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi
  [[ -n "$fallback" ]] || return 1
  printf '%s' "$fallback"
}

private_key_secret_name() {
  local name=""

  name=$(mirrored_value \
    "OCTESTRA_GITHUB_APP_PRIVATE_KEY_SECRET|github_app|private_key_secret_key_name|$DEFAULT_PRIVATE_KEY_SECRET")
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  printf '%s' "$name"
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
    if ! mirrored_value "$entry" >/dev/null; then
      report fail "$CONFIG_PATH has no ${rest%%|*}.${rest#*|}"
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
# 0 in the comparison octestra-lifecycle.yml routes on, so nothing runs and nothing fails.
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
    expected=$(mirrored_value "$entry") || continue
    actual=$(gh variable get "$name" 2>/dev/null || true)
    if [[ -z "$actual" ]]; then
      report fail "$name is unset; run 'octestra.sh vars sync'"
    elif [[ "$actual" != "$expected" ]]; then
      report fail \
        "$name is '$actual' but $CONFIG_PATH says '$expected'; run 'octestra.sh vars sync'"
    fi
  done
  if (( FAILURES == before )); then
    report ok "the five Octestra repository variables match $CONFIG_PATH"
  fi
}

# Checks that the secret exists by name only. Its value is never read.
check_private_key_secret() {
  local names=""
  local private_key_secret=""

  private_key_secret=$(private_key_secret_name) ||
    die "$CONFIG_PATH has no usable github_app.private_key_secret_key_name"

  names=$(
    gh api \
      -H "Accept: application/vnd.github+json" \
      "/repos/$REPOSITORY/actions/secrets" \
      --paginate \
      --jq '.secrets[].name' 2>/dev/null || true
  )
  if [[ -z "$names" ]]; then
    report warn \
      "could not list Actions secrets; repository admin access is needed to check $private_key_secret"
    return
  fi
  if printf '%s\n' "$names" | grep -q -x "$private_key_secret"; then
    report ok "$private_key_secret is set"
  else
    report fail "$private_key_secret is not set; no job can mint an App token"
  fi
}

# Two different failures live here. A status update looks the field up by *name*, so a rename
# makes every update fail; octestra-lifecycle.yml routes on the field *ID*, so a stale ID
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
  # A referenced local action that is absent fails the run before the consumer's agent starts,
  # so catch both file and directory forms here.
  while IFS= read -r called; do
    if [[ ! -f "$called" && ! -f "$called/action.yml" && ! -f "$called/action.yaml" ]]; then
      report fail "a workflow references $called, which does not exist"
    fi
  done < <(
    grep -h -o -E '^[^#]*uses: \./[^[:space:]]+' "$ENTRY_WORKFLOW" |
      sed -E 's|.*uses: \./||' |
      sort -u
  )
  # No match means the workflow calls some other Octestra, which is a finding rather than an
  # error: without '|| true' the failed grep would abort this script under 'set -o pipefail'.
  refs=$(
    grep -h -o -E "^[^#]*uses: $action_repository(/[^@[:space:]]+)?@[^[:space:]]+" \
      "$ENTRY_WORKFLOW" |
      sed -E 's|.*@||' |
      sort -u || true
  )
  if [[ -z "$refs" ]]; then
    report fail \
      "$ENTRY_WORKFLOW does not call $action_repository; this script and the workflow disagree about which Octestra runs"
  elif [[ $(printf '%s\n' "$refs" | wc -l | tr -d ' ') != "1" ]]; then
    report fail \
      "$ENTRY_WORKFLOW calls $action_repository at more than one ref: $(printf '%s' "$refs" | tr '\n' ' ')"
  elif [[ "$refs" != "$installed_ref" ]]; then
    report fail \
      "$ENTRY_WORKFLOW calls $action_repository@$refs but this script records @$installed_ref; rerun install.sh or 'octestra.sh ref'"
  else
    report ok "$ENTRY_WORKFLOW calls $INSTALLED_ACTION"
    tag=$(latest_version_tag "$action_repository") || true
    if [[ -n "$tag" && "$tag" != "$installed_ref" ]]; then
      report note \
        "$action_repository has a newer tag $tag; switch with 'octestra.sh ref --latest'"
    fi
  fi
  if (( FAILURES == before )); then
    report ok "every local action referenced by $ENTRY_WORKFLOW exists"
  fi
}

check_prompts() {
  local before="$FAILURES"
  local key=""
  local path=""

  if [[ ! -f "$CONFIG_PATH" ]]; then
    return
  fi
  for key in lifecycle_in_progress lifecycle_validation loop_todo; do
    path=$(config_scalar prompts "$key" || true)
    if [[ -z "$path" && "$key" == "loop_todo" ]]; then
      path=".github/octestra/prompts/loop-todo.md.hbs"
    fi
    if [[ -z "$path" ]]; then
      continue
    fi
    if [[ ! -f "$path" ]]; then
      report fail "prompts.$key points at $path, which is not in this checkout"
    fi
  done
  if (( FAILURES == before )); then
    report ok "every configured prompt is in this checkout"
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
    expected=$(mirrored_value "$entry") ||
      die "$CONFIG_PATH has no value for $name"
    if [[ "$mode" == "sync" ]]; then
      info "setting $name to '$expected' in $REPOSITORY"
      gh variable set "$name" --body "$expected"
      continue
    fi
    actual=$(gh variable get "$name" 2>/dev/null || true)
    if [[ "$actual" != "$expected" ]]; then
      printf "Octestra: %s does not match: variable '%s', %s '%s'\n" \
        "$name" "$actual" "$CONFIG_PATH" "$expected" >&2
      status=1
    fi
  done
  return "$status"
}

# Newest stable release tag in a repository, by version sort. Release candidates and moving major
# tags are ignored. An unreachable, private, or untagged repository yields an empty string.
latest_version_tag() {
  local repository="$1"

  gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/$repository/tags" \
    --paginate \
    --jq '.[].name' 2>/dev/null |
    grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' |
    sort -V |
    tail -n 1
}

stable_release_version() {
  local ref="$1"

  if [[ "$ref" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    printf '%s' "${ref#v}"
    return
  fi
  return 1
}

changelog_versions() {
  local changelog="$1"

  awk '
    /^## \[/ {
      version = $0
      sub(/^## \[/, "", version)
      sub(/\].*$/, "", version)
      print version
      next
    }
    /^## [0-9]/ {
      version = $0
      sub(/^## /, "", version)
      sub(/ .*/, "", version)
      print version
    }
  ' "$changelog"
}

show_update_changelog() {
  local source_dir="$1"
  local target="$2"
  local current_repository="${INSTALLED_ACTION%@*}"
  local current_ref="${INSTALLED_ACTION##*@}"
  local target_repository="${target%@*}"
  local target_ref="${target##*@}"
  local current_version=""
  local target_version=""
  local changelog="$source_dir/CHANGELOG.md"
  local notes=""

  if ! current_version=$(stable_release_version "$current_ref") ||
    ! target_version=$(stable_release_version "$target_ref") ||
    [[ "$current_repository" != "$target_repository" ]]; then
    info "could not show changelog entries for $INSTALLED_ACTION to $target"
    info "review the changelog at https://github.com/$target_repository/blob/$target_ref/CHANGELOG.md"
    if [[ "$current_repository" == "$target_repository" ]]; then
      info "review changes at https://github.com/$target_repository/compare/$current_ref...$target_ref"
    fi
    return
  fi

  if [[ "$current_version" == "$target_version" ]]; then
    return
  fi
  if [[ "$(printf '%s\n%s\n' "$current_version" "$target_version" | sort -V | head -n 1)" != "$current_version" ]]; then
    info "could not show changelog entries because $target_ref is not newer than $current_ref"
    info "review changes at https://github.com/$target_repository/compare/$current_ref...$target_ref"
    return
  fi
  if [[ ! -f "$changelog" ]] ||
    ! changelog_versions "$changelog" | grep -Fqx "$current_version"; then
    info "could not find $current_ref in the changelog for $target"
    info "review the changelog at https://github.com/$target_repository/blob/$target_ref/CHANGELOG.md"
    return
  fi

  notes=$(awk -v current_version="$current_version" '
    /^## \[/ {
      version = $0
      sub(/^## \[/, "", version)
      sub(/\].*$/, "", version)
      if (version == current_version) {
        exit
      }
      printing = 1
    }
    /^## [0-9]/ {
      version = $0
      sub(/^## /, "", version)
      sub(/ .*/, "", version)
      if (version == current_version) {
        exit
      }
      printing = 1
    }
    printing {
      print
    }
  ' "$changelog")
  [[ -n "$notes" ]] || return

  printf 'Octestra: changes since %s:\n\n%s\n' "$current_ref" "$notes"
}

# Resolves a reference spec against the installed one. Both 'ref' and 'update' accept the
# same forms, so they cannot disagree about what `@2` or `--latest` means.
resolve_action_spec() {
  local spec="$1"
  local repository="${INSTALLED_ACTION%@*}"
  local current_ref="${INSTALLED_ACTION##*@}"
  local target=""
  local tag=""

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
      ;;
    *)
      die "expected OWNER/REPO@REF, @REF, OWNER/REPO, or --latest, not '$spec'"
      ;;
  esac

  [[ "${target%@*}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] ||
    die "repository must be OWNER/REPO: ${target%@*}"
  [[ "${target##*@}" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    die "ref must be a git ref: ${target##*@}"
  printf '%s' "$target"
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

  target=$(resolve_action_spec "$spec")
  if [[ "$target" == "$INSTALLED_ACTION" ]]; then
    info "already calling $target"
    return
  fi

  rewrite_action_reference "$INSTALLED_ACTION" "$target"
  info "switched from $INSTALLED_ACTION to $target"
  info "review and commit .github to put the change into effect"
  info "run 'octestra.sh update' to install the files that ref ships"
}

# The skill directory a previous install chose. Reading it back means an update cannot move
# the skill to a directory the repository's agent does not read.
installed_skill_target() {
  local candidate=""

  for candidate in claude codex agents; do
    if [[ -d ".$candidate/skills/octestra-setup-migration-epic" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Prints nothing but the unpacked directory: the caller captures it.
download_source() {
  local target="$1"
  local archive=""
  local root=""

  TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/octestra-update.XXXXXX")
  archive="$TEMP_DIR/octestra.tar.gz"
  gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/${target%@*}/tarball/${target##*@}" > "$archive" ||
    die "could not download $target"
  mkdir -p "$TEMP_DIR/source"
  tar -xzf "$archive" -C "$TEMP_DIR/source"
  root=$(find "$TEMP_DIR/source" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [[ -n "$root" ]] || die "the archive for $target contained no repository"
  printf '%s' "$root"
}

confirm_update() {
  local target="$1"
  local assume_yes="$2"
  local answer=""

  if [[ "$assume_yes" == true ]] || ! has_interactive_tty; then
    return
  fi
  cat > /dev/tty <<EOF
Update $REPOSITORY from $target?
  .github/workflows/octestra-lifecycle.yml  replaced
  .github/octestra/actions/         kept as they are
  .github/octestra/prompts/         kept as they are
  .github/octestra/octestra.sh      replaced
  the installed agent skill         replaced
  .github/octestra/config.yml       kept as it is
It also re-syncs the five Octestra repository variables from config.yml.
Workflow edits are lost, so check 'git status' first.
EOF
  printf 'Continue? [y/N]: ' > /dev/tty
  IFS= read -r answer < /dev/tty
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "update cancelled" ;;
  esac
}

update_command() {
  local spec=""
  local assume_yes=false
  local target=""
  local source_dir=""
  local skill_target=""
  local status_field=""
  local client_id=""
  local oidc=()

  while (( $# > 0 )); do
    case "$1" in
      --yes)
        assume_yes=true
        shift
        ;;
      --latest|@*|*/*)
        [[ -z "$spec" ]] || die "update takes one reference spec, not '$spec' and '$1'"
        spec="$1"
        shift
        ;;
      *)
        die "update takes a reference spec and --yes, not '$1'"
        ;;
    esac
  done

  [[ -f "$CONFIG_PATH" ]] || die "$CONFIG_PATH not found; run install.sh first"
  status_field=$(config_scalar status field_name) || die "$CONFIG_PATH has no status.field_name"
  client_id=$(config_scalar github_app client_id) ||
    die "$CONFIG_PATH has no github_app.client_id"
  skill_target=$(installed_skill_target) ||
    die "no Octestra skill directory found; run install.sh with --skill-target instead"

  if [[ -n "$spec" ]]; then
    target=$(resolve_action_spec "$spec")
  else
    target=$(resolve_action_spec --latest)
  fi

  # `id-token: write` is one commented line in octestra-lifecycle.yml, outside every marker
  # pair, so an update would comment it out again unless the installer is told to enable it.
  if grep -q '^[[:space:]]*id-token: write' "$ENTRY_WORKFLOW"; then
    oidc=(--enable-oidc)
  fi

  trap cleanup EXIT
  info "downloading $target"
  source_dir=$(download_source "$target")
  [[ -f "$source_dir/install.sh" ]] || die "$target ships no install.sh"
  show_update_changelog "$source_dir" "$target"
  confirm_update "$target" "$assume_yes"

  # The installer that just arrived does the work: it preserves consumer policy, replaces the
  # lifecycle workflow, rewrites action references and syncs the variables. This script must not
  # hold a second copy of any of that. `${oidc[@]}` is expanded through `+` because an empty array under
  # `set -u` is a fatal error in the bash that ships with macOS.
  bash "$source_dir/install.sh" \
    --target "$PWD" \
    --source-dir "$source_dir" \
    --org "$ORGANIZATION" \
    --status-field "$status_field" \
    --skill-target "$skill_target" \
    --github-app-client-id "$client_id" \
    --repository "${target%@*}" \
    --ref "${target##*@}" \
    --yes \
    ${oidc[@]+"${oidc[@]}"}

  info "updated to $target; review the result with 'git diff' before committing"
  # This script is one of the files that was just replaced. Exiting here stops the shell from
  # reading the rest of a file that changed underneath it.
  exit 0
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
    update)
      resolve_repository
      update_command "$@"
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
