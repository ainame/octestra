# TODO

Open work, ordered by what unblocks what. Design rationale lives in `docs/design.md`; the rules this
work must respect live in `AGENTS.md`.

The configuration restructuring has shipped: the config control plane, the single-workflow lifecycle
topology, and operation namespacing. Both loop shapes (per-issue fan-out and aggregate) were built
but never run, and have been removed — see §1. Everything below is what remains.

## 1. Bring loops back

Loops are intended to return. Scheduled automation sweeping many tasks at once is what turns
Octestra from a task executor into a feedback cycle, and the seams it needs are still in place: the
`lifecycle/<verb>` namespace, the `src/shared/` ⁄ `src/lifecycle/` split, and the
`octestra-lifecycle-*.yml` naming all leave room for a `src/loop/` and `octestra-loop-<id>.yml` to
slot back in.

The previous implementation was removed because it had never been exercised, not because it was
wrong. `git log` has all of it — operations, both reference workflows, their prompts and their
config block — so start by reading it rather than from scratch. The four platform invariants that
described loop machinery only (**P4** schedules run only on the default branch, **P5** schedules are
best-effort, **P6** an empty `strategy.matrix` fails the job, **P9** REST pagination offset) were
deleted from `AGENTS.md` and are quoted verbatim in the removal commit message. They are verified
platform properties that each cost real debugging; recover them from that commit before rebuilding,
and restore the ones the new shape actually relies on.

The design questions are unsettled and need a human, not an agent:

- The missing capability is creation. A loop could comment on and promote existing tasks, but never
  open them. What bounds `loop/create-task` — a per-run cap, and where does it live?
- How are duplicates suppressed across runs, given a best-effort scheduler that may delay, skip or
  repeat a run?
- Do created tasks start in `Todo` for a human to release, or enter the lifecycle directly?

## 2. Put agent execution behind a trust boundary

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
- Validation proof transferred to that job as bounded, strictly validated data.
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
the lifecycle, across the loop policy fields that existed at the time, and across an agent-authored
`next_status`, and still cannot make a rename safe without a field-definition lookup on the write
path. Not worth the split contract.

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
