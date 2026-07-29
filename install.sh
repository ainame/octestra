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
# The action reference every workflow template ships with. Templates must run unmodified
# from a checkout, so this is a working upstream reference rather than a placeholder; the
# installer rewrites it to the repository and ref an installation should track.
readonly TEMPLATE_ACTION_REPOSITORY="ainame/octestra"
readonly TEMPLATE_ACTION_REF="main"
readonly DEFAULT_SOURCE_REPOSITORY="$TEMPLATE_ACTION_REPOSITORY"
readonly DEFAULT_SOURCE_REF="main"
readonly API_VERSION="2026-03-10"
# The maintenance CLI installed beside config.yml. It owns config.yml -> repository
# variable mirroring for the consumer, and this installer uses it for the initial sync
# rather than carrying a second implementation.
readonly MAINTENANCE_SCRIPT=".github/octestra/octestra.sh"
# Installed files a consumer is expected to edit mark their editable parts with these
# comments. Everything outside a marked region is replaced on a rerun; the content inside
# one is carried across. The suffix a backup gets when nothing could be carried.
readonly CUSTOM_REGION_PREFIX="# octestra:custom:"
readonly BACKUP_SUFFIX=".octestra-bak"

TARGET_DIR="."
SOURCE_DIR=""
SOURCE_REPOSITORY="${OCTESTRA_REPOSITORY:-$DEFAULT_SOURCE_REPOSITORY}"
# Empty means "resolve": a fork tracks its default branch, upstream pins its newest
# version tag. Set explicitly by --ref or OCTESTRA_REF, which skips resolution.
SOURCE_REF="${OCTESTRA_REF:-}"
ORGANIZATION=""
STATUS_FIELD_NAME=""
SKILL_TARGET=""
GITHUB_APP_CLIENT_ID=""
ASSUME_YES=false
ENABLE_OIDC=false
FORK_INSTALL=false
CONFIG_PRESERVED=false
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
                         Octestra repository the generated workflows call
                         (default: ainame/octestra)
  --fork                 Shorthand for --repository ORGANIZATION/octestra
  --ref REF              Octestra ref the generated workflows call. Defaults to the
                         newest version tag for ainame/octestra and to main for any
                         other repository, falling back to main when untagged
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

# The workflows a consumer runs reference Octestra as `owner/repo@ref`. Installing from a
# fork points that reference at the fork's default branch, so the consumer executes only
# code their own organization controls, at the cost of merging upstream changes
# themselves. Installing from upstream pins the newest version tag instead, so the
# reference cannot move under them between runs.
configure_action_source() {
  local fork_repository=""
  local choice=""

  fork_repository="$ORGANIZATION/${TEMPLATE_ACTION_REPOSITORY##*/}"

  if [[ "$FORK_INSTALL" == true ]]; then
    [[ "$SOURCE_REPOSITORY" == "$DEFAULT_SOURCE_REPOSITORY" ]] ||
      die "--fork and --repository name different Octestra repositories"
    SOURCE_REPOSITORY="$fork_repository"
    return
  fi
  if [[ "$SOURCE_REPOSITORY" != "$DEFAULT_SOURCE_REPOSITORY" || "$ASSUME_YES" == true ]] ||
    ! has_interactive_tty; then
    return
  fi

  cat > /dev/tty <<EOF
Which Octestra repository should the generated workflows call?
  1) $DEFAULT_SOURCE_REPOSITORY (upstream, pinned to its newest version tag)
  2) $fork_repository (your fork, tracking its default branch)
  Choose 2 to run only code your organization controls. Fork
  https://github.com/$DEFAULT_SOURCE_REPOSITORY into '$ORGANIZATION' first, and expect to
  merge upstream changes into that fork yourself.
EOF
  printf 'Choice [1]: ' > /dev/tty
  IFS= read -r choice < /dev/tty
  case "${choice:-1}" in
    1) ;;
    2) SOURCE_REPOSITORY="$fork_repository" ;;
    *) die "invalid Octestra repository selection: $choice" ;;
  esac
}

resolve_source_reference() {
  local tag=""

  if [[ -n "$SOURCE_REF" ]]; then
    return
  fi
  if [[ "$SOURCE_REPOSITORY" == "$DEFAULT_SOURCE_REPOSITORY" ]]; then
    tag=$(latest_version_tag) || true
  fi
  SOURCE_REF="${tag:-$DEFAULT_SOURCE_REF}"
}

# Both values are substituted into installed workflow files, so anything that is not a
# plain repository or ref is rejected before it reaches sed.
validate_source_reference() {
  [[ "$SOURCE_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] ||
    die "Octestra repository must be OWNER/REPO: $SOURCE_REPOSITORY"
  [[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    die "Octestra ref must be a git ref: $SOURCE_REF"
}

# Newest version tag in the source repository, by version sort. Tags that are not plain
# versions are ignored, so a release candidate never becomes the default. An unreachable,
# private, or untagged repository yields an empty string and the caller falls back to the
# default branch.
latest_version_tag() {
  gh api \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: $API_VERSION" \
    "/repos/$SOURCE_REPOSITORY/tags" \
    --paginate \
    --jq '.[].name' 2>/dev/null |
    grep -E '^v?[0-9]+(\.[0-9]+)*$' |
    sort -V |
    tail -n 1
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
  else
    if [[ -n "$script_path" ]]; then
      script_dir=$(cd "$(dirname "$script_path")" 2>/dev/null && pwd || true)
    fi
    if [[ -n "$script_dir" && -d "$script_dir/templates" ]]; then
      TEMPLATE_DIR="$script_dir/templates"
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

  # Carry the consumer's regions over first, so their content goes through the same OIDC and
  # action-reference rewrites as the rest of the file.
  merge_custom_regions

  if [[ "$ENABLE_OIDC" == true ]]; then
    local workflow=""
    while IFS= read -r workflow; do
      replace_token "$workflow" "  # id-token: write" "  id-token: write"
    done < <(find "$INSTALL_TREE/.github/workflows" -type f -name '*.yml' -print)
  fi

  rewrite_action_references
}

# Repoints every `TEMPLATE_ACTION_REPOSITORY[/subpath]@TEMPLATE_ACTION_REF` reference at
# the repository and ref this installation tracks. This replaces a value that is already
# valid rather than filling in a placeholder, so a template still runs unmodified from a
# checkout of Octestra itself.
rewrite_action_references() {
  # The optional group carries a subpath, so a nested action reference like
  # `<repo>/<subpath>@<ref>` would move with the root action. Nothing Octestra ships uses
  # one today; the group stays so that adding one is not a silent install-time trap.
  # BSD sed rejects an alternation with an anchor inside a group, so the pattern
  # carries no left boundary; it does not need one, because the literal it matches is one
  # Octestra ships rather than anything a consumer could write.
  local pattern="$TEMPLATE_ACTION_REPOSITORY(/[^@[:space:]]+)?@$TEMPLATE_ACTION_REF"
  local replacement="$SOURCE_REPOSITORY\\1@$SOURCE_REF"
  local file=""
  local output=""

  if [[ "$SOURCE_REPOSITORY" == "$TEMPLATE_ACTION_REPOSITORY" &&
    "$SOURCE_REF" == "$TEMPLATE_ACTION_REF" ]]; then
    return
  fi

  while IFS= read -r file; do
    output="$file.octestra-tmp"
    sed -E "s|$pattern|$replacement|g" "$file" > "$output"
    # The install tree carries an executable maintenance script, and a fresh temporary
    # file does not inherit its mode.
    if [[ -x "$file" ]]; then
      chmod +x "$output"
    fi
    mv "$output" "$file"
  done < <(find "$INSTALL_TREE" -type f -print)

  if grep -R -E -q "$pattern" "$INSTALL_TREE"; then
    die "installation left a $TEMPLATE_ACTION_REPOSITORY@$TEMPLATE_ACTION_REF reference"
  fi
}

# Returns the region name when a line is a `begin` or `end` marker, and non-zero otherwise.
# The match is anchored on the whole comment, so the header block that documents the syntax
# (`#     # octestra:custom:begin <name>`) stays prose instead of becoming a marker.
custom_region_marker() {
  local line="$1"
  local kind="$2"
  local prefix="$CUSTOM_REGION_PREFIX$kind "
  local trimmed=""

  trimmed=${line#"${line%%[![:space:]]*}"}
  if [[ "$trimmed" != "$prefix"* ]]; then
    return 1
  fi
  trimmed=${trimmed#"$prefix"}
  printf '%s' "${trimmed%"${trimmed##*[![:space:]]}"}"
}

# Region names a file declares, in the order they appear.
custom_region_names() {
  local file="$1"
  local line=""
  local name=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if name=$(custom_region_marker "$line" begin); then
      printf '%s\n' "$name"
    fi
  done < "$file"
}

# The lines a file has inside one region, excluding the markers themselves.
custom_region_body() {
  local file="$1"
  local wanted="$2"
  local line=""
  local name=""
  local inside=false

  while IFS= read -r line || [[ -n "$line" ]]; do
    if name=$(custom_region_marker "$line" begin) && [[ "$name" == "$wanted" ]]; then
      inside=true
      continue
    fi
    if name=$(custom_region_marker "$line" end) && [[ "$name" == "$wanted" ]]; then
      inside=false
      continue
    fi
    if [[ "$inside" == true ]]; then
      printf '%s\n' "$line"
    fi
  done < "$file"
}

# Membership is tested on a captured list rather than through `grep -q`, which would exit on
# the first match and leave the producing loop writing to a closed pipe.
declares_custom_region() {
  local names=""

  names=$(custom_region_names "$1")
  [[ $'\n'"$names"$'\n' == *$'\n'"$2"$'\n'* ]]
}

# A malformed marker set would make the merge silently drop content, so both files are
# checked before anything is spliced.
assert_valid_custom_regions() {
  local file="$1"
  local line=""
  local name=""
  local open=""
  local duplicates=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if name=$(custom_region_marker "$line" begin); then
      [[ -z "$name" ]] && die "$file has a custom region marker with no name"
      [[ -z "$open" ]] || die "$file nests custom region '$name' inside '$open'"
      open="$name"
      continue
    fi
    if name=$(custom_region_marker "$line" end); then
      [[ "$open" == "$name" ]] ||
        die "$file ends custom region '$name' but '${open:-nothing}' is open"
      open=""
    fi
  done < "$file"
  [[ -z "$open" ]] || die "$file never ends custom region '$open'"

  duplicates=$(custom_region_names "$file" | sort | uniq -d)
  [[ -z "$duplicates" ]] ||
    die "$file declares a custom region more than once: $(printf '%s' "$duplicates" | tr '\n' ' ')"
}

# Rewrites the staged template so each region carries the content the installed file has.
splice_custom_regions() {
  local template="$1"
  local installed="$2"
  local output="$3"
  local line=""
  local name=""
  local body=""
  local skipping=""

  : > "$output"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -n "$skipping" ]]; then
      if name=$(custom_region_marker "$line" end) && [[ "$name" == "$skipping" ]]; then
        printf '%s\n' "$line" >> "$output"
        skipping=""
      fi
      continue
    fi
    printf '%s\n' "$line" >> "$output"
    if ! name=$(custom_region_marker "$line" begin); then
      continue
    fi
    # A region the installed file does not have is new in this version: let the template
    # body through untouched instead of emptying it.
    if ! declares_custom_region "$installed" "$name"; then
      continue
    fi
    skipping="$name"
    body=$(custom_region_body "$installed" "$name")
    if [[ -n "$body" ]]; then
      printf '%s\n' "$body" >> "$output"
    fi
  done < "$template"
}

back_up_installed_file() {
  local installed="$1"
  local relative="$2"
  local reason="$3"

  cp "$installed" "$installed$BACKUP_SUFFIX"
  info "saved the previous $relative as $relative$BACKUP_SUFFIX: $reason"
  info "move anything still needed into the new file, then delete the backup"
}

merge_installed_file() {
  local template="$1"
  local installed="$2"
  local relative="$3"
  local merged="$template.octestra-merged"
  local name=""
  local carried=()
  local orphans=()

  assert_valid_custom_regions "$template"
  if [[ -z "$(custom_region_names "$installed")" ]]; then
    if ! diff -q "$template" "$installed" >/dev/null 2>&1; then
      back_up_installed_file "$installed" "$relative" \
        "it has no $CUSTOM_REGION_PREFIX markers, so no customization could be carried over"
    fi
    return
  fi
  assert_valid_custom_regions "$installed"

  while IFS= read -r name; do
    if declares_custom_region "$template" "$name"; then
      carried+=("$name")
    else
      orphans+=("$name")
    fi
  done < <(custom_region_names "$installed")

  if (( ${#orphans[@]} > 0 )); then
    back_up_installed_file "$installed" "$relative" \
      "the new version has no custom region named ${orphans[*]}"
  fi

  splice_custom_regions "$template" "$installed" "$merged"
  mv "$merged" "$template"
  if (( ${#carried[@]} > 0 )); then
    info "carried custom regions into $relative: ${carried[*]}"
  fi
}

# Consumers customize the workflows Octestra installs, and a rerun has to update Octestra's
# own steps without discarding that work. Every staged file that marks custom regions is
# merged with the copy already installed before anything is copied over it.
merge_custom_regions() {
  local template=""
  local relative=""
  local installed=""

  while IFS= read -r template; do
    if ! grep -q -- "$CUSTOM_REGION_PREFIX" "$template"; then
      continue
    fi
    relative="${template#"$INSTALL_TREE"/}"
    installed="$TARGET_DIR/$relative"
    if [[ ! -f "$installed" ]]; then
      continue
    fi
    merge_installed_file "$template" "$installed" "$relative"
  done < <(find "$INSTALL_TREE" -type f -print)
}

# config.yml is the consumer's control plane, so a rerun must not reset the runners, branch
# template or prompt paths they chose. Staging the file they already have makes the copy below
# write it back unchanged; only a first installation renders the template.
preserve_installed_config() {
  local config="$TARGET_DIR/.github/octestra/config.yml"

  CONFIG_PRESERVED=false
  if [[ ! -f "$config" ]]; then
    return
  fi
  cp "$config" "$INSTALL_TREE/.github/octestra/config.yml"
  CONFIG_PRESERVED=true
  info "kept the existing config.yml"
  # Values this run resolved that the file contradicts. Rendering them would discard the rest
  # of the file, so they are reported instead of applied.
  if [[ -n "$GITHUB_APP_CLIENT_ID" ]] &&
    ! grep -q "client_id: \"$GITHUB_APP_CLIENT_ID\"" "$config"; then
    info "config.yml keeps its own github_app.client_id, not the --github-app-client-id passed to this run"
  fi
  if ! grep -q "field_name: \"$STATUS_FIELD_NAME\"" "$config"; then
    info "config.yml does not record status.field_name: \"$STATUS_FIELD_NAME\"; operations look the field up by that name"
  fi
  if ! grep -q "field_id: \"$FIELD_ID\"" "$config"; then
    info "config.yml does not record status.field_id: \"$FIELD_ID\"; routing compares that ID, so fix it there"
  fi
}

copy_and_render_templates() {
  local config="$TARGET_DIR/.github/octestra/config.yml"

  preserve_installed_config
  (cd "$INSTALL_TREE" && tar -cf - .) | (cd "$TARGET_DIR" && tar -xf -)
  [[ -f "$config" ]] || die "Octestra config template was not installed"
  [[ -x "$TARGET_DIR/$MAINTENANCE_SCRIPT" ]] ||
    die "the maintenance script was not installed as executable: $MAINTENANCE_SCRIPT"
  if [[ "$CONFIG_PRESERVED" == false ]]; then
    if [[ -n "$GITHUB_APP_CLIENT_ID" ]]; then replace_token "$config" "YOUR-GITHUB-APP-CLIENT-ID" "$GITHUB_APP_CLIENT_ID"; fi
    replace_token "$config" "__OCTESTRA_STATUS_FIELD_NAME__" "$STATUS_FIELD_NAME"
    replace_token "$config" "__OCTESTRA_STATUS_FIELD_ID__" "$FIELD_ID"
  fi
  if grep -q "__OCTESTRA_" "$config"; then die "installation left unresolved Octestra placeholders"; fi
  # Mirroring runs through the script that was just installed, so the tool a consumer will
  # use for every later sync is the one exercised at install time.
  (cd "$TARGET_DIR" && bash "$MAINTENANCE_SCRIPT" vars sync)
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
    --fork)
      FORK_INSTALL=true
      shift
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
require_command sort
require_command uniq
require_command diff

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
configure_action_source
resolve_source_reference
validate_source_reference
info "generated workflows will call $SOURCE_REPOSITORY@$SOURCE_REF"

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
info "check the result with '$MAINTENANCE_SCRIPT doctor'"
