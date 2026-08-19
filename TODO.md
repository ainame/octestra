# TODO

Open work, ordered by what unblocks what. Design rationale lives in `docs/design.md`; the rules this
work must respect live in `AGENTS.md`.

The configuration restructuring has shipped: the config control plane, the single-workflow lifecycle
topology, operation namespacing, and the minimal Todo triage loop. Earlier fan-out and aggregate
loop designs owned too much policy and were removed. The retained loop kernel discovers enabled
EPIC configuration units and renders a prompt for each; the repository's triage skill owns task
discovery, selection, limits, domain knowledge, readiness policy and issue preparation. Octestra
validates its result before exclusively applying eligible `Todo` to `Ready` updates.

## 1. Put agent execution behind a trust boundary

No workflow separates agent execution from privileged finalization: `finalize-task` still runs in
the same job as the agent. The rule Octestra intends is that a job executing an agent gets no
privileged token, checks out with `persist-credentials: false`, and runs no lifecycle operation —
its results cross into a trusted job as a bounded, strictly validated artifact, and that job mints a
fresh App token. Nothing implements that yet. This is the largest security gap in the repository.

Octestra initially supports private repositories whose members are trusted to run coding agents.
That reduces who can supply malicious input but does not reduce the impact once an agent, dependency
or command is compromised.

The target:

- Separate agent-controlled execution from trusted lifecycle finalization.
- Read-only checkout tokens with `persist-credentials: false`.
- No repository write token for validation agents by default.
- If an agent must comment, a short-lived token limited to repository read plus issue and pull
  request write, revoked immediately afterwards.
- A fresh lifecycle token minted in a separate job that does not execute pull request code.
- Validation result transferred to that job as bounded, strictly validated data.
- A default-branch ruleset the task App cannot bypass. Task agents still need write access to create
  their own branches.
- OIDC roles, model credentials, network access, and persistent self-hosted runners treated as
  separate risks: isolated ephemeral runners, narrowly scoped non-production credentials.

An early implementation experiment is in the git stash named
`wip: validation token boundary experiment`.

### Open decisions (need a human, not an agent)

- Must the agent post comments directly, or can trusted finalization render every comment from
  agent-produced proof?
- Should comment tokens be opt-in rather than present in generated defaults?
- What cloud and network isolation is required when validation uses Bedrock or another hosted model?

## 2. Status options stay name-addressed (closed, not planned)

Kept as a record so this is not re-attempted. Renaming a status option in the organization does
break an installation, and the fix looked available — but it is not, and the earlier claim here that
`GET`/`POST .../issue-field-values` both accept `single_select_option_id` was wrong.

Checked against the REST docs for `2026-03-10` and a live organization field:

- `GET .../issue-field-values` returns `issue_field_id` per element and `id`, `name`, `color` inside
  `single_select_option`. Reads can be ID-addressed.
- `POST .../issue-field-values` takes `{field_id, value}`, and for a single_select the `value` must
  be the option's **display name**. There is no ID form.

So a write must know the live name either way. ID-addressing the reads while writes resolve a name
was implemented and reverted: it adds a second vocabulary (`config.yml` keys alongside names) across
the lifecycle, across the loop policy fields that existed at the time, and across an agent-authored
`next_status`, and still cannot make a rename safe without a field-definition lookup on the write
path. Not worth the split contract.

`config.yml` therefore records no option IDs at all — only `field_name` and `field_id`. If
rename-safety is ever wanted for *routing* alone, `status_key` could be derived by looking the
event's `option.id` up in a key-to-ID map, which would mean reintroducing that map to `config.yml`.
Every API exchange would stay name-based, so it is a far smaller change than the one abandoned here,
but it would still leave `updateStatus` and `getStatus` name-keyed.

Revisit if the write endpoint gains ID addressing.

## 3. `install.sh` hardening

- Re-running the installer over an existing installation should preserve consumer edits to
  `config.yml`; today it regenerates the file.
- The installer overwrites workflows, prompts, and the agent skill on every run. Say so before doing
  it.
