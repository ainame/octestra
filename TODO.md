# TODO

Open work, ordered by what unblocks what. Design rationale lives in `docs/design.md`; the rules this
work must respect live in `AGENTS.md`.

The Loop and configuration restructuring has shipped: the config control plane, the two-layer
lifecycle topology, operation namespacing, and both loop shapes (per-issue fan-out and aggregate).
Everything below is what remains.

## 1. `loop/create-task`

A loop can comment on and promote existing tasks, but cannot create them. Closing that gap — letting
a loop open sub-issues under an EPIC from its own analysis — is what turns Octestra from a task
executor into a feedback cycle.

Design questions to settle first: what bounds creation (a per-run cap belongs in `apply`), how
duplicates are suppressed across runs given P5, and whether created tasks start in `Todo` for a
human or enter the lifecycle directly.

## 2. Migrate the lifecycle to the loop trust boundary

Loop workflows already separate agent execution from privileged finalization (`docs/design.md` §4).
The lifecycle workflows do not: `finalize-task` still runs in the same job as the agent. This is the
largest security gap in the repository.

Octestra workflows execute a repository-configured coding agent with access to repository content,
issue instructions, dependency output, and potentially GitHub or cloud credentials. Private
repositories reduce who can supply malicious input but do not reduce the impact once an agent or a
command is compromised.

The target, mirroring what loops already do:

- Separate agent-controlled execution from trusted lifecycle finalization.
- Read-only checkout tokens with `persist-credentials: false`.
- No repository write token for validation agents by default.
- If an agent must comment, a short-lived token limited to repository read plus issue and pull
  request write, revoked immediately afterwards.
- A fresh lifecycle token minted in a separate job that does not execute pull request code.
- Validation proof transferred to that job as bounded, strictly validated data.
- A default-branch ruleset the task App cannot bypass. Task agents still need write access to create
  their own branches.
- OIDC roles, model credentials, network access, and persistent self-hosted runners treated as
  separate risks: isolated ephemeral runners, narrowly scoped non-production credentials.

An early implementation experiment is in the git stash named
`wip: validation token boundary experiment`.

### Open decisions (need a human, not an agent)

- Does Octestra support public consumer repositories, or does it document private, trusted-member
  repositories as its initial security boundary?
- Must the agent post comments directly, or can trusted finalization render every comment from
  agent-produced proof?
- Should comment tokens be opt-in rather than present in generated defaults?
- What cloud and network isolation is required when validation uses Bedrock or another hosted model?

## 3. Status options stay name-addressed (closed, not planned)

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
the lifecycle, both loop policy fields, and the agent-authored `next_status`, and still cannot make
a rename safe without a field-definition lookup on the write path. Not worth the split contract.

`config.yml` therefore records no option IDs at all — only `field_name` and `field_id`. If
rename-safety is ever wanted for *routing* alone, `status_key` could be derived by looking the
event's `option.id` up in a key-to-ID map, which would mean reintroducing that map to `config.yml`.
Every API exchange would stay name-based, so it is a far smaller change than the one abandoned here,
but it would still leave `updateStatus` and `getStatus` name-keyed.

Revisit if the write endpoint gains ID addressing.

## 4. `install.sh` hardening

- Re-running the installer over an existing installation should preserve consumer edits to
  `config.yml`; today it regenerates the file.
- The installer overwrites workflows, prompts, and the agent skill on every run. Say so before doing
  it.

## 5. Remove deprecated aliases

`src/index.ts` maps nine bare operation names to their `lifecycle/` equivalents and warns. They were
kept for one release. Remove the alias table and its warning once consumers have migrated.
