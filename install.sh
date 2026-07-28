#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_STATUS_FIELD_NAME="AI Task Status"
# The Issue Field options Octestra's state graph requires, as name|color|priority.
# Single source for the creation payload, the missing-option report, and the presence
# check, so the seven statuses are written out exactly once.
readonly REQUIRED_OPTIONS=(
  "Todo|gray|1"
  "Ready|blue|2"
  "In Progress|yellow|3"
  "Validation|pink|4"
  "Human Review|purple|5"
  "Blocked|red|6"
  "Done|green|7"
)
readonly DEFAULT_SOURCE_REPOSITORY="ainame/octestra"
readonly DEFAULT_SOURCE_REF="main"
readonly API_VERSION="2026-03-10"

TARGET_DIR="."
SOURCE_DIR=""
SOURCE_REPOSITORY="${OCTESTRA_REPOSITORY:-$DEFAULT_SOURCE_REPOSITORY}"
SOURCE_REF="${OCTESTRA_REF:-$DEFAULT_SOURCE_REF}"
ORGANIZATION=""
STATUS_FIELD_NAME=""
SKILL_TARGET=""
GITHUB_APP_CLIENT_ID=""
ASSUME_YES=false
ENABLE_OIDC=false
TEMP_DIR=""

usage() {
  cat <<'EOF'
Install Octestra boilerplate into a consumer repository.

Usage:
  install.sh [options]

Options:
  --org ORGANIZATION     GitHub organization that owns the Issue Field
  --status-field NAME    Issue Field name (default: AI Task Status)
  --skill-target TARGET  Skill directory: claude, codex, or agents
  --github-app-client-id ID
                         GitHub App client ID for generated workflows
  --target DIRECTORY     Consumer repository directory (default: current directory)
  --source-dir DIRECTORY Use a local Octestra checkout instead of downloading a release
  --repository OWNER/REPO
                         Octestra source repository (default: ainame/octestra)
  --ref REF              Octestra source ref (default: main)
  --yes                  Create a missing Issue Field without confirmation
  --enable-oidc          Enable GitHub OIDC permissions in generated workflows
  -h, --help             Show this help

Environment:
  OCTESTRA_REPOSITORY    Default source repository
  OCTESTRA_REF           Default source ref
EOF
}

info() {
  printf 'Octestra: %s\n' "$*"
}

die() {
  printf 'Octestra: error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required"
}

prompt_value() {
  local prompt="$1"
  local default_value="$2"
  local value=""

  if ! has_interactive_tty; then
    printf '%s' "$default_value"
    return
  fi

  printf '%s [%s]: ' "$prompt" "$default_value" > /dev/tty
  IFS= read -r value < /dev/tty
  printf '%s' "${value:-$default_value}"
}

has_interactive_tty() {
  [[ ( -t 0 || -t 1 ) && -r /dev/tty && -w /dev/tty ]]
}

prompt_required_value() {
  local prompt="$1"
  local value=""

  if ! has_interactive_tty; then
    die "could not infer $prompt; pass --org"
  fi

  while [[ -z "$value" ]]; do
    printf '%s: ' "$prompt" > /dev/tty
    IFS= read -r value < /dev/tty
  done
  printf '%s' "$value"
}

select_skill_target() {
  local choice=""

  if [[ -n "$SKILL_TARGET" ]]; then
    SKILL_TARGET=${SKILL_TARGET#.}
  elif has_interactive_tty; then
    cat > /dev/tty <<'EOF'
Select the coding-agent skill directory:
  1) .claude/skills
  2) .codex/skills
  3) .agents/skills
EOF
    printf 'Choice [1]: ' > /dev/tty
    IFS= read -r choice < /dev/tty
    case "${choice:-1}" in
      1|claude|.claude) SKILL_TARGET="claude" ;;
      2|codex|.codex) SKILL_TARGET="codex" ;;
      3|agents|.agents) SKILL_TARGET="agents" ;;
      *) die "invalid skill directory selection: $choice" ;;
    esac
  else
    die "skill directory cannot be selected interactively; pass --skill-target"
  fi

  case "$SKILL_TARGET" in
    claude|codex|agents) ;;
    *) die "--skill-target must be claude, codex, or agents" ;;
  esac
}

owner_from_remote_url() {
  local url="$1"
  local path=""
  local owner=""
  local repository=""

  url=${url%.git}
  case "$url" in
    http://*/*|https://*/*|ssh://*/*)
      path=${url#*://}
      path=${path#*/}
      ;;
    *@*:*/*)
      path=${url#*:}
      ;;
    *)
      return 1
      ;;
  esac

  owner=${path%%/*}
  repository=${path#*/}
  [[ -n "$owner" && -n "$repository" && "$repository" != "$path" ]] || return 1
  printf '%s' "$owner"
}

infer_organization() {
  local inferred=""
  local remote_url=""
  local remotes=""

  inferred=$(cd "$TARGET_DIR" && gh repo view --json owner --jq '.owner.login' 2>/dev/null || true)
  if [[ -n "$inferred" ]]; then
    printf '%s' "$inferred"
    return
  fi

  remote_url=$(git -C "$TARGET_DIR" remote get-url origin 2>/dev/null || true)
  if [[ -n "$remote_url" ]]; then
    owner_from_remote_url "$remote_url" || true
    return
  fi

  remotes=$(git -C "$TARGET_DIR" remote 2>/dev/null || true)
  if [[ -n "$remotes" && $(printf '%s\n' "$remotes" | wc -l | tr -d ' ') == "1" ]]; then
    remote_url=$(git -C "$TARGET_DIR" remote get-url "$remotes" 2>/dev/null || true)
    owner_from_remote_url "$remote_url" || true
  fi
}

confirm_create() {
  local answer=""

  if [[ "$ASSUME_YES" == true ]]; then
    return
  fi
  if ! has_interactive_tty; then
    die "Issue Field '$STATUS_FIELD_NAME' does not exist; rerun with --yes to create it"
  fi

  printf "Create Issue Field '%s' in '%s'? [y/N]: " \
    "$STATUS_FIELD_NAME" "$ORGANIZATION" > /dev/tty
  IFS= read -r answer < /dev/tty
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "installation cancelled" ;;
  esac
}

configure_oidc() {
  local answer=""

  if [[ "$ENABLE_OIDC" == true || "$ASSUME_YES" == true ]] || ! has_interactive_tty; then
    return
  fi

  cat > /dev/tty <<'EOF'
Enable GitHub Actions OIDC federation? [y/N]
  Use this for workload identity, for example AWS IAM role assumption:
    aws-actions/configure-aws-credentials@v6
      with:
        role-to-assume: arn:aws:iam::123456789012:role/octestra-agent
  This enables `id-token: write` in all generated Octestra workflows.
  It is not needed for GitHub App authentication or static AWS access keys.
EOF
  printf 'Choice [N]: ' > /dev/tty
  IFS= read -r answer < /dev/tty
  case "$answer" in
    y|Y|yes|YES) ENABLE_OIDC=true ;;
    ""|n|N|no|NO) ;;
    *) die "invalid OIDC selection: $answer" ;;
  esac
}

configure_github_app_client_id() {
  local client_id=""

  if [[ -n "$GITHUB_APP_CLIENT_ID" || "$ASSUME_YES" == true ]] || ! has_interactive_tty; then
    return
  fi

  cat > /dev/tty <<'EOF'
GitHub App client ID (optional)
  Generated workflows use this App for agent pushes and lifecycle updates.
  Install the App in this organization with at least:
    - Contents: Read and write
    - Issues: Read and write
    - Pull requests: Read and write
  Press Enter to keep the YOUR-GITHUB-APP-CLIENT-ID placeholder.
EOF
  printf 'Client ID: ' > /dev/tty
  IFS= read -r client_id < /dev/tty
  GITHUB_APP_CLIENT_ID="$client_id"
}

json_quote() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}

replace_token() {
  local file="$1"
  local token="$2"
  local replacement="$3"
  local escaped=""
  local output="${file}.octestra-tmp"

  escaped=$(printf '%s' "$replacement" | sed 's/[\\&|]/\\&/g')
  sed "s|$token|$escaped|g" "$file" > "$output"
  mv "$output" "$file"
}

find_issue_field() {
  local row=""
  local id=""
  local name=""
  local data_type=""

  FIELD_ID=""
  FIELD_DATA_TYPE=""
  while IFS=$'\t' read -r id name data_type; do
    if [[ "$name" == "$STATUS_FIELD_NAME" ]]; then
      FIELD_ID="$id"
      FIELD_DATA_TYPE="$data_type"
      return
    fi
  done < <(
    gh api \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      "/orgs/$ORGANIZATION/issue-fields" \
      --paginate \
      --jq '.[] | [.id, .name, .data_type] | @tsv'
  )
}

create_issue_field() {
  local payload_file="$TEMP_DIR/issue-field.json"
  local quoted_name=""
  quoted_name=$(json_quote "$STATUS_FIELD_NAME")

  cat > "$payload_file" <<EOF
{
  "name": $quoted_name,
  "description": "Status for agentic tasks",
  "data_type": "single_select",
  "visibility": "organization_members_only",
  "options": [$(required_options_json "${REQUIRED_OPTIONS[@]}")]
}
EOF

  info "creating Issue Field '$STATUS_FIELD_NAME' in '$ORGANIZATION'"
  if ! gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: $API_VERSION" \
    "/orgs/$ORGANIZATION/issue-fields" \
    --input "$payload_file" >/dev/null; then
    die "failed to create Issue Field; organization administrator access is required"
  fi
}

# Renders the requested REQUIRED_OPTIONS entries as a JSON array body. Accepts either
# a full "name|color|priority" entry or a bare name, so the missing-option report can
# pass the names it collected.
required_options_json() {
  local separator=""
  local requested=""
  local entry=""
  local name=""
  local rest=""
  local found=false

  for requested in "$@"; do
    found=false
    for entry in "${REQUIRED_OPTIONS[@]}"; do
      if [[ "${entry%%|*}" == "${requested%%|*}" ]]; then
        name="${entry%%|*}"
        rest="${entry#*|}"
        printf '%s{"name":"%s","color":"%s","priority":%s}' \
          "$separator" "$name" "${rest%%|*}" "${rest##*|}"
        separator=","
        found=true
        break
      fi
    done
    [[ "$found" == true ]] || die "unknown required Issue Field option: $requested"
  done
}

print_add_missing_options_command() {
  local additions="[$(required_options_json "$@")]"

  cat >&2 <<EOF

Add the missing options without replacing existing option IDs by running
the following command with jq installed and GitHub CLI authenticated:

curl --fail --silent --show-error --location \\
  -H "Accept: application/vnd.github+json" \\
  -H "Authorization: Bearer \$(gh auth token)" \\
  -H "X-GitHub-Api-Version: $API_VERSION" \\
  "https://api.github.com/orgs/$ORGANIZATION/issue-fields/$FIELD_ID" |
jq --argjson additions '$additions' '
  {
    options: (
      ((.options // .single_select_options // []) |
        map({id, name, description, color, priority})) +
      \$additions
    )
  }
' |
curl --fail --silent --show-error --location --request PATCH \\
  -H "Accept: application/vnd.github+json" \\
  -H "Authorization: Bearer \$(gh auth token)" \\
  -H "Content-Type: application/json" \\
  -H "X-GitHub-Api-Version: $API_VERSION" \\
  "https://api.github.com/orgs/$ORGANIZATION/issue-fields/$FIELD_ID" \\
  --data-binary @-
EOF
}

# Operations address statuses by display name (P1), so the installer does not need
# option IDs — only the guarantee that every required option exists. Checking here is
# what makes a missing or renamed option fail at setup instead of mid-workflow.
verify_required_options() {
  local present=""
  local name=""
  local entry=""
  local required=""

  while IFS= read -r name; do
    present+="|$name|"
  done < <(
    gh api \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      "/orgs/$ORGANIZATION/issue-fields" \
      --paginate \
      --jq ".[] | select(.id == $FIELD_ID) | (.options // .single_select_options // [])[] | .name"
  )

  local missing=()
  for entry in "${REQUIRED_OPTIONS[@]}"; do
    required="${entry%%|*}"
    [[ "$present" == *"|$required|"* ]] || missing+=("$required")
  done

  if (( ${#missing[@]} > 0 )); then
    printf "Octestra: error: Issue Field '%s' is missing required options: %s\n" \
      "$STATUS_FIELD_NAME" "${missing[*]}" >&2
    print_add_missing_options_command "${missing[@]}"
    exit 1
  fi
}

resolve_template_directory() {
  local script_dir=""
  local script_path="${BASH_SOURCE[0]-}"
  local archive=""
  local extracted_root=""

  if [[ -n "$SOURCE_DIR" ]]; then
    TEMPLATE_DIR="${SOURCE_DIR%/}/templates"
    SCRIPT_DIR="${SOURCE_DIR%/}/scripts"
  else
    if [[ -n "$script_path" ]]; then
      script_dir=$(cd "$(dirname "$script_path")" 2>/dev/null && pwd || true)
    fi
    if [[ -n "$script_dir" && -d "$script_dir/templates" ]]; then
      TEMPLATE_DIR="$script_dir/templates"
      SCRIPT_DIR="$script_dir/scripts"
    else
      archive="$TEMP_DIR/octestra.tar.gz"
      info "downloading $SOURCE_REPOSITORY@$SOURCE_REF"
      gh api \
        -H "Accept: application/vnd.github+json" \
        "/repos/$SOURCE_REPOSITORY/tarball/$SOURCE_REF" > "$archive"
      mkdir -p "$TEMP_DIR/source"
      tar -xzf "$archive" -C "$TEMP_DIR/source"
      extracted_root=$(find "$TEMP_DIR/source" -mindepth 1 -maxdepth 1 -type d | head -n 1)
      [[ -n "$extracted_root" ]] || die "downloaded archive did not contain a repository"
      TEMPLATE_DIR="$extracted_root/templates"
      SCRIPT_DIR="$extracted_root/scripts"
    fi
  fi

  [[ -d "$TEMPLATE_DIR" ]] || die "template directory not found: $TEMPLATE_DIR"
}

prepare_install_tree() {
  INSTALL_TREE="$TEMP_DIR/install"
  [[ -d "$TEMPLATE_DIR/.github" ]] || die "GitHub templates not found in $TEMPLATE_DIR"
  [[ -d "$TEMPLATE_DIR/skills" ]] || die "skill templates not found in $TEMPLATE_DIR"

  mkdir -p "$INSTALL_TREE" "$INSTALL_TREE/.$SKILL_TARGET/skills"
  (cd "$TEMPLATE_DIR" && tar -cf - .github) | (cd "$INSTALL_TREE" && tar -xf -)
  (cd "$TEMPLATE_DIR/skills" && tar -cf - .) |
    (cd "$INSTALL_TREE/.$SKILL_TARGET/skills" && tar -xf -)

  if [[ "$ENABLE_OIDC" == true ]]; then
    local workflow=""
    while IFS= read -r workflow; do
      replace_token "$workflow" "  # id-token: write" "  id-token: write"
    done < <(find "$INSTALL_TREE/.github/workflows" -type f -name '*.yml' -print)
  fi
}

copy_and_render_templates() {
  local config="$TARGET_DIR/.github/octestra/config.yml"

  (cd "$INSTALL_TREE" && tar -cf - .) | (cd "$TARGET_DIR" && tar -xf -)
  [[ -f "$config" ]] || die "Octestra config template was not installed"
  if [[ -n "$GITHUB_APP_CLIENT_ID" ]]; then replace_token "$config" "YOUR-GITHUB-APP-CLIENT-ID" "$GITHUB_APP_CLIENT_ID"; fi
  replace_token "$config" "__OCTESTRA_STATUS_FIELD_NAME__" "$STATUS_FIELD_NAME"
  replace_token "$config" "__OCTESTRA_STATUS_FIELD_ID__" "$FIELD_ID"
  if grep -q "__OCTESTRA_" "$config"; then die "installation left unresolved Octestra placeholders"; fi
  (cd "$TARGET_DIR" && bash "$SCRIPT_DIR/octestra-vars.sh" sync .github/octestra/config.yml)
}

while (( $# > 0 )); do
  case "$1" in
    --org)
      [[ $# -ge 2 ]] || die "--org requires a value"
      ORGANIZATION="$2"
      shift 2
      ;;
    --status-field)
      [[ $# -ge 2 ]] || die "--status-field requires a value"
      STATUS_FIELD_NAME="$2"
      shift 2
      ;;
    --skill-target)
      [[ $# -ge 2 ]] || die "--skill-target requires a value"
      SKILL_TARGET="$2"
      shift 2
      ;;
    --github-app-client-id)
      [[ $# -ge 2 ]] || die "--github-app-client-id requires a value"
      GITHUB_APP_CLIENT_ID="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || die "--target requires a value"
      TARGET_DIR="$2"
      shift 2
      ;;
    --source-dir)
      [[ $# -ge 2 ]] || die "--source-dir requires a value"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --repository)
      [[ $# -ge 2 ]] || die "--repository requires a value"
      SOURCE_REPOSITORY="$2"
      shift 2
      ;;
    --ref)
      [[ $# -ge 2 ]] || die "--ref requires a value"
      SOURCE_REF="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=true
      shift
      ;;
    --enable-oidc)
      ENABLE_OIDC=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

require_command gh
require_command git
require_command tar
require_command sed
require_command find
require_command grep

[[ -d "$TARGET_DIR" ]] || die "target directory does not exist: $TARGET_DIR"
TARGET_DIR=$(cd "$TARGET_DIR" && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/octestra-install.XXXXXX")
trap cleanup EXIT

gh auth status >/dev/null 2>&1 || die "authenticate GitHub CLI with 'gh auth login'"

if [[ -z "$ORGANIZATION" ]]; then
  inferred_org=$(infer_organization)
  if [[ -n "$inferred_org" ]]; then
    ORGANIZATION=$(prompt_value "GitHub organization" "$inferred_org")
  else
    ORGANIZATION=$(prompt_required_value "GitHub organization")
  fi
fi
if [[ -z "$STATUS_FIELD_NAME" ]]; then
  STATUS_FIELD_NAME=$(prompt_value "Issue Field name" "$DEFAULT_STATUS_FIELD_NAME")
fi
select_skill_target
configure_oidc
configure_github_app_client_id

find_issue_field
if [[ -z "$FIELD_ID" ]]; then
  confirm_create
  create_issue_field
  find_issue_field
  [[ -n "$FIELD_ID" ]] || die "created Issue Field could not be retrieved"
fi
[[ "$FIELD_DATA_TYPE" == "single_select" ]] ||
  die "Issue Field '$STATUS_FIELD_NAME' must use the single_select data type"

verify_required_options
resolve_template_directory
prepare_install_tree
copy_and_render_templates

info "installed boilerplate in $TARGET_DIR"
info "installed octestra-setup-migration-epic in .$SKILL_TARGET/skills"
info "customize runners, agent integration, secrets, and prompts before enabling the workflow"
