# Octestra: Loop concept and configuration restructuring

Working plan, revised after review. Written so that another agent can execute each phase.
Delete this file once every phase has shipped.

## 1. Goal

Add a **Loop** concept (scheduled, repository-wide automation) to Octestra without making the
existing Issue-event lifecycle a special case of it, and restructure configuration so that both
systems share one control plane instead of duplicating workflow-level `env` blocks.

Motivating loops:

| Loop | Cadence | Shape | Outcome |
|---|---|---|---|
| Triage tasks sitting in `Todo` | daily | one agent run per issue | comment + promote to `Ready` |
| Diagnose tasks stuck in `Blocked` | weekly | one agent run per issue | comment / remind; sometimes promote |
| Retrospective on merged task PRs | when enough accumulate | one agent run for the whole set | open a skill-improvement PR |

"Framework" means Octestra owns the mechanism (selection, prompting, applying results, guard rails)
and the consumer owns the policy (which loops exist, when they run, which agent, what it may do).

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Loop is a **separate entry point**, never a `schedule` trigger bolted onto the lifecycle entry point | The lifecycle entry point keys `concurrency.group`, `run-name`, and its routing `if` on `github.event.issue.number`, which is empty on `schedule`. Every scheduled run would collapse into one concurrency group. |
| D2 | **One workflow file per loop** (`octestra-loop-<id>.yml`), with no central loop router | The only thing a router would have shared is configuration, and D3 removes that need. A router forces routing by `github.event.schedule` string, which requires globally unique cron strings and duplicates each loop's identity across cron condition, dispatch choice list, job name, context JSON, and filename. |
| D3 | Platform values (runner labels, App client ID, status field ID) move to **repository `vars`** | Per the GitHub context availability table, `vars` is allowed in `jobs.<id>.runs-on`, `jobs.<id>.if`, `jobs.<id>.with.<id>`, `concurrency`, and `run-name`; `env` is allowed in none of them. This is the documented answer to the open `TODO.md` question "Simplify runner configuration for lifecycle workflows". |
| D4 | The lifecycle collapses from 3 workflow layers to 2: `octestra-lifecycle.yml` -> `octestra-lifecycle-<status>.yml` | The middle layer exists only to convert workflow `env` into `workflow_call` inputs so `runs-on` can read it. D3 removes that need. |
| D5 | Per-status routing keys on a **status key emitted by the transition guard**, not on status option IDs in the workflow | The guard job already runs unconditionally for every routed event, so this costs nothing. It keeps option IDs authoritative in `config.yml` (D6) and removes seven values from `vars`. |
| D6 | `.github/octestra/config.yml` is the source of truth, including for the values mirrored into `vars`. It is the **only file `install.sh` generates**; all workflow templates install byte-identically | One reviewable, version-controlled file. Placeholder substitution collapses from many workflow files to one config file. |
| D7 | Status option **IDs** remain the authoritative identity of a status | Consumers may rename status option labels; IDs are stable. See C1. |
| D8 | Prompts move to `.github/octestra/prompts/` | Everything Octestra owns in the consumer repo lives under one directory. |
| D9 | Operations are namespaced `lifecycle/<verb>`, `loop/<verb>`, bare for scope-neutral | Paired operations get identical names (`lifecycle/report-failure` <-> `loop/report-failure`), verb-first naming survives inside each namespace, and `src/lifecycle/`, `src/loop/`, `src/shared/` map 1:1. |
| D10 | **Do not** use `secrets: inherit` | It hands every repository and organization secret to a workflow that executes an agent, which directly contradicts the trust-boundary work in `TODO.md`. Agent credentials are declared explicitly instead. See C7. |
| D11 | Loop workflows separate the **agent job** from a **trusted finalize job**, handing results over as a bounded artifact | Loops run unattended on a schedule, so they are the worst place to keep agent execution and privileged lifecycle writes in one job. Doing this here also pilots the pattern `TODO.md` wants for the lifecycle. |
| D12 | A loop outcome is one of: comment / report, guarded status update, open a pull request, or no-op | Status update is *an* outcome, not the model. Reminders and retrospectives do not map onto a transition. When a loop does change status, the lifecycle observes it normally and nothing bypasses the state machine. |

### Rejected alternatives

- **A single `octestra-loop.yml` bundling all loops** (the original idea). Its motivation was sharing
  the `env` anchor block. `vars` removes that motivation, and bundling then costs cron-string
  routing plus five places per loop that must agree. See D2.
- **A single `tick` cron driving loops from a data file.** `on.schedule.cron` only accepts YAML
  literals, so per-loop cadence would need persisted last-run state. GitHub's cron delivery is
  already delayed and skippable; a second scheduler on top makes failure unobservable.
- **A bootstrap job that reads `config.yml` and fans values out via `needs.*.outputs`.** The
  lifecycle entry point deliberately filters most Issue Field events with a job-level `if` that
  costs no runner minutes; a bootstrap job would start a runner for every unrelated field change.
- **One workflow file per lifecycle status with its own `on: issues` trigger** (perfect symmetry
  with D2). Rejected because every field change would create a workflow *run record* per file.
  Cost stays zero but the Actions tab becomes unreadable. A single event stream needs one
  demultiplexer; independent cron triggers do not. The resulting asymmetry is derived from trigger
  cardinality, not accident.

## 3. Constraints to record in `TODO.md`

- **C1. Status option *names* are part of Octestra's contract.** `allowedTransitions` in
  `src/operations.ts`, `updateStatus`, and `getStatus` all key on the display name, while identity
  is the option ID (D7). Renaming an option keeps routing working but breaks the operations. It also
  breaks `install.sh`, so today this fails at setup rather than silently.
  **Future work:** let operations address options by ID
  (`GET`/`POST .../issue-field-values` accept `single_select_option_id`), reducing names to
  presentation. Until then, document that the seven labels are fixed.
- **C2. `schedule` only runs on the default branch**, against its latest commit, and only if the
  workflow file exists there. Loops cannot be exercised from a pull request. Every loop must also be
  reachable via `workflow_dispatch`, defaulting to a dry run.
- **C3. `schedule` is disabled after 60 days of repository inactivity**, and delivery is best-effort
  (delayed or skipped under load). Loops must be idempotent; correctness must not depend on a run
  happening exactly once per period.
- **C4. An empty `strategy.matrix` fails the job**, it does not skip it. A matrix built from
  `fromJSON(needs.<job>.outputs.<x>)` must be guarded by a job-level `if` (job `if` is evaluated
  before matrix expansion, so this is safe), and the guard output and the array must be derived from
  the same validated value. The matrix job limit is 256.
- **C5. Reusable workflow nesting allows ten levels** (caller plus nine). Not a real constraint here;
  recorded because an earlier draft claimed four.
- **C6. `vars` are strings and an unset variable evaluates to `''`**, which casts to `0` in numeric
  comparison, producing a silent no-match rather than an error. Routing comparisons must be string
  comparisons (`format('{0}', x) == vars.Y`), runner labels must have literal fallbacks
  (`${{ vars.X || 'ubuntu-latest' }}`), and drift must fail loudly.
- **C7. `secrets: inherit` is all-or-nothing.** A reusable workflow that executes an agent must not
  inherit; agent credentials are declared in `on.workflow_call.secrets` and passed explicitly by the
  caller. (Today `octestra-in-progress.yml` documents `secrets.YOUR_AGENT_API_KEY` without declaring
  it, so it silently evaluates to an empty string. Phase 2 fixes the example, not by inheriting.)

## 4. Target layout

```
.github/
  workflows/
    octestra-lifecycle.yml              # on: issues  -> guard + route          (generic)
    octestra-lifecycle-in-progress.yml  # workflow_call                          (consumer edits agent)
    octestra-lifecycle-validation.yml   # workflow_call                          (consumer edits agent)
    octestra-loop-<id>.yml              # on: schedule + workflow_dispatch       (consumer owns, one per loop)
  octestra/
    config.yml                          # the only generated file
    prompts/
      lifecycle-in-progress.md.hbs
      lifecycle-validation.md.hbs
      loop-<id>.md.hbs
```

Naming is symmetric (`octestra-<system>[-<unit>].yml`) and the file that carries the trigger owns
the policy in both systems. Layer count differs because the lifecycle demultiplexes one event
stream while each loop has its own trigger (D2, and the last rejected alternative in section 2).

```
issues:field_added ─▶ octestra-lifecycle.yml ─┬─▶ octestra-lifecycle-in-progress.yml
                       (guard emits status_key)└─▶ octestra-lifecycle-validation.yml

schedule / dispatch ─▶ octestra-loop-<id>.yml   (select ─▶ agent ─▶ trusted finalize)
                              │
                              └── guarded status update ─▶ issues:field_added ─▶ lifecycle
```

Source layout mirrors the operation namespaces:

```
src/
  shared/     config.ts, github-client.ts, prompt.ts, proof.ts, status.ts
  lifecycle/  operations.ts
  loop/       select.ts, operations.ts
  index.ts    dispatch
```

## 5. Configuration model

Split by *when* a value is needed, not by what it is.

| Tier | Examples | Lives in | Why not elsewhere |
|---|---|---|---|
| Platform | runner labels, App client ID, status field ID | `config.yml`, mirrored to `vars` | Needed before a job starts; no file can be read then |
| Policy | status field name, status option IDs, branch templates, prompt paths, loop selection and guard rails | `config.yml`, read at runtime by operations | Reviewable and versioned |
| Wiring | cron strings, job graph, agent invocation | workflow YAML | GitHub accepts only literals; also the consumer's customisation surface |
| Intent | `epic-config`, `task-config` | Issue body | Unchanged |

### 5.1 `config.yml`

```yaml
version: 1

github_app:
  client_id: "Iv1.xxxxxxxx"        # mirrored to vars

runners:                            # mirrored to vars
  orchestration: ubuntu-slim
  agent: ubuntu-latest

status:
  field_name: AI Task Status
  field_id: 12345                   # mirrored to vars
  options:                          # option ID -> status key (authoritative, not mirrored)
    todo: 1
    ready: 2
    in_progress: 3
    validation: 4
    human_review: 5
    blocked: 6
    done: 7

branch:
  task: "octestra/{epic_id}/issue-{issue_number}"
  loop: "octestra/loop/{loop_id}/{run_number}"

prompts:
  lifecycle_in_progress: .github/octestra/prompts/lifecycle-in-progress.md.hbs
  lifecycle_validation: .github/octestra/prompts/lifecycle-validation.md.hbs

loops:
  triage-todo:
    prompt: .github/octestra/prompts/loop-triage-todo.md.hbs
    select:
      epic: null              # EPIC issue number. null requires labels (see 7.3)
      status: Todo
      labels: []
      updated_before: 24h     # skip recently touched issues; this is the idempotency guard
      limit: 10               # cap on selected issues
      scan_budget: 300        # cap on candidate issues examined, independent of limit
      order: oldest
    apply:
      allowed_status: [Ready, Blocked]   # statuses this loop may move a task to
      assign_owner: true                 # required when promoting; see 7.5
      dry_run: false
    report_issue: null        # issue for aggregate summaries and loop failure reports
```

The installed template must contain every key, documented inline, with everything beyond a minimal
working set commented out. There is no schema validation tool, so the template is the documentation.
`src/shared/config.ts` must nonetheless validate on load and fail with actionable messages.

### 5.2 Mirrored into `vars`

Exactly four values. Everything else is read at runtime from `config.yml`.

| `vars` name | `config.yml` path | Used by |
|---|---|---|
| `OCTESTRA_GITHUB_APP_CLIENT_ID` | `github_app.client_id` | `create-github-app-token` `with:` in reusable workflows |
| `OCTESTRA_ORCHESTRATION_RUNNER` | `runners.orchestration` | `runs-on` |
| `OCTESTRA_AGENT_RUNNER` | `runners.agent` | `runs-on` |
| `OCTESTRA_STATUS_FIELD_ID` | `status.field_id` | the entry point's pre-runner `if` |

The `field_added` payload does expose `github.event.issue_field.name`, so the entry point could
filter on the field name instead. It is not used: the name would still have to come from a variable
(workflow templates install byte-identically, so it cannot be a literal), so the variable count is
unchanged, and the ID survives a field rename while the name does not (D7).

Status option IDs are deliberately **not** mirrored (D5): they are consumed only by the transition
guard, which reads `config.yml` directly.

Repository variables resolve from the calling repository and are available inside called reusable
workflows, so local `./.github/workflows/...` calls work unchanged.

### 5.3 Drift

Mirroring creates a window where `vars` and `config.yml` disagree. Contained by:

1. **Small surface.** Four values, three of which change approximately never.
2. **Loud failure.** `lifecycle/validate-transition` takes a `platform-vars` input carrying the four
   `vars` values, compares them against `config.yml`, and fails with a diff. The guard already runs
   on every routed event, so this needs no extra job and no extra runner.
3. **No chicken-and-egg.** Runner labels use literal fallbacks (C6), so the guard can start and
   report the problem even when its own variable is unset.
4. **A local check.** `make octestra-check-vars` exits non-zero on drift; `make octestra-sync-vars`
   applies. `install.sh` runs the sync at the end of installation.

Sync is a shell script over `gh variable set`, reading `config.yml` with a small Node script that
uses the already-vendored `yaml` package (no new dependency, no `yq` requirement). A CLI is out of
scope.

### 5.4 Where config is read from

Operations read `config.yml` from the **default branch via the Contents API**, not the checkout.

- Jobs without a checkout (guard, merged-task finalisation, failure reporting) can still read it.
- `schedule` only fires on the default branch (C2), so both systems get the same authority.
- Per `TODO.md`, the control plane is not read from a workspace an agent may have modified.

Prompts stay in the workspace and are read from the checkout: they are agent-facing content that
should be reviewable in a pull request.

Escape hatch: the action takes a `config-ref` input so a branch's config can be exercised from a
loop's `workflow_dispatch`.

## 6. Operation naming

Existing names remain as deprecated aliases for one release; `index.ts` maps them and emits
`core.warning`.

| Scope-neutral | `lifecycle/` | `loop/` |
|---|---|---|
| `update-status` | `lifecycle/validate-transition` | `loop/select-tasks` |
| `assign-owner` | `lifecycle/prepare-task` | `loop/prepare-run` |
| `assign-pr-owner` | `lifecycle/finalize-task` | `loop/finalize-run` |
| `request-review` | `lifecycle/prepare-validation` | `loop/report-failure` |
| `report-proof` | `lifecycle/finalize-validation` | |
| `resolve-task-pr` | `lifecycle/finalize-merged-task` | |
| | `lifecycle/build-task-context` | |
| | `lifecycle/build-validation-context` | |
| | `lifecycle/report-failure` | |

### 6.1 Dispatch refactor (prerequisite for Loop)

`src/index.ts` currently builds `OperationContext` before the `switch`, calling
`positiveNumber("issue-number", ...)` unconditionally. `loop/select-tasks`, aggregate
`loop/prepare-run`, and `loop/report-failure` have no issue number and would fail before reaching
their handler. Context construction must become per-namespace, with the issue number required only
by operations whose contract needs one.

## 7. Loop contract

### 7.1 `loop-context`

Peer of the existing `lifecycle-context`: one JSON input carrying the run's identity.

```jsonc
{
  "loop_id": "triage-todo",
  "trigger": "schedule",     // or "workflow_dispatch"
  "dry_run": false,          // overrides loops.<id>.apply.dry_run
  "config_ref": ""           // empty means default branch
}
```

Selection and guard rails live in `config.yml`, not here, so a policy change does not require
editing workflow wiring.

### 7.2 Operations

| Operation | Inputs | Outputs | Behaviour |
|---|---|---|---|
| `loop/select-tasks` | `loop-context` | `issues` (JSON array of `{number, title, status, updated_at}`), `count`, `digest` (Markdown table), `loop_ready`, `partial` | Resolves `loops.<id>.select`. `loop_ready` is `'false'` when the array is empty; both outputs are derived from the same validated array (C4). `partial` is `'true'` when `scan_budget` was reached. |
| `loop/prepare-run` | `loop-context`, optional `issue-number` | `prompt`, `result_path`, `artifact_path` | Renders `loops.<id>.prompt`. Per-issue when `issue-number` is given, otherwise for the whole set. |
| `loop/finalize-run` | `loop-context`, `proof-path`, optional `issue-number` | `outcome`, `applied` | Validates the agent's result document, posts a comment, and applies a status change only when it appears in `apply.allowed_status`. `dry_run` reports without applying. |
| `loop/report-failure` | `loop-context` | | Peer of `lifecycle/report-failure`. A loop has no task to block, so it comments on `report_issue` when configured and otherwise relies on workflow failure. |

`loop/finalize-run` reuses the existing proof document format and `renderProofComment`.

### 7.3 Selection

There is no dependable Issue Field search qualifier today. Implement `loop/select-tasks` as:

1. If `select.epic` is set, list sub-issues via `GET /repos/{owner}/{repo}/issues/{n}/sub_issues`
   (counterpart of the parent endpoint already used by `getParentNumber`).
2. Otherwise list open issues narrowed by `select.labels`, **excluding pull requests** (the issues
   endpoint returns both).
3. Read `issue-field-values` per candidate and filter by `select.status`.
4. Apply `updated_before`, `order`, then `limit`.

Step 3 is an N+1 scan and `limit` only bounds the result, not the work. Therefore:

- A repository-wide selection (`epic: null` and `labels: []`) is **rejected** by config validation.
  One of the two must narrow the set.
- `scan_budget` caps candidates examined, independently of `limit`. Reaching it sets `partial` and
  is surfaced in `digest`; it is not an error, because C3 means the next run picks up the rest.

Keeping all of this inside one operation means a future search qualifier changes the operation, not
the workflow contract.

### 7.4 Guard rails

- `select.limit` and `select.scan_budget` are required, with small defaults.
- `strategy.max-parallel` defaults small in the templates.
- Per-issue jobs use `concurrency.group: octestra-<issue_number>`, the same key as
  `octestra-lifecycle-in-progress.yml`. Concurrency groups are repository-scoped, so a loop cannot
  run against a task that is mid-execution. (`matrix` is available in job-level `concurrency`.)
- `apply.allowed_status` bounds what a loop may do. Templates default to `Ready` and `Blocked`;
  promoting straight to `In Progress` would start many agent runs at once.
- `workflow_dispatch` defaults `dry-run` to `true` (C2).

### 7.5 Ownership gap

A task promoted `Todo -> Ready` while unassigned later fails in `buildTaskContext` with "No assigned
task owner found in the issue activity". Fix in Phase 4: give `assign-owner` an explicit assignee
input, and make `loop/finalize-run` assign an owner whenever it promotes a task
(`apply.assign_owner`).

### 7.6 Trust boundary (D11)

Every loop workflow has three jobs:

1. `select` — trusted, no checkout of agent-modifiable content, orchestration runner.
2. `agent` — runs the consumer's agent. Checkout with `persist-credentials: false`. Receives only
   the credentials the agent needs, declared explicitly. Writes its result document and uploads it
   as an artifact. **No lifecycle operation runs in this job.**
3. `finalize` — trusted. Downloads the artifact, generates a fresh App token, and runs
   `loop/finalize-run`, which strictly validates the document before acting.

Artifact names must be unique per matrix leg (`octestra-loop-<loop_id>-<issue_number>`).

This is stricter than the current lifecycle workflows, which still run `finalize-task` in the agent
job. That is the pre-existing gap recorded in `TODO.md`; Loop must not widen it, and the pattern
established here is the intended migration target for the lifecycle.

## 8. Phases

Sequential — each depends on the previous — but each is independently releasable and independently
valuable. Phases 1-3 close the open `TODO.md` runner question and remove the installer's
placeholder machinery whether or not Loop ever ships.

### Phase 1 — Config plane

1. Add `templates/.github/octestra/config.yml` with all keys, inline documentation, and non-default
   sections commented out. Repository-specific values use placeholders.
2. Move `templates/.github/octestra-prompts/*.hbs` to `templates/.github/octestra/prompts/`, renamed
   `lifecycle-in-progress.md.hbs` and `lifecycle-validation.md.hbs`.
3. Add `src/shared/config.ts`: fetch `.github/octestra/config.yml` via the Contents API at
   `config-ref` (default: default branch), parse, validate, expose a typed object, fail with
   actionable messages.
4. Add a `config-ref` input to `action.yml`.
5. Replace the hardcoded prompt paths in `src/index.ts` and the `workflow-context` branch-template
   parsing with config values. Keep `prompt-template` and `workflow-context` working as overrides
   for one release.
6. Add `scripts/octestra-vars.mjs` (reads `config.yml`, prints the four variables) plus
   `scripts/octestra-vars.sh`, `make octestra-sync-vars`, and `make octestra-check-vars`.
7. Move `install.sh`'s placeholder substitution from the workflow files to `config.yml`: it is now
   the only generated file. Run the vars sync at the end of installation.

Verify: `make all`. In a scratch repository, installation produces a populated `config.yml` and the
four variables.

### Phase 2 — `vars` and topology

1. Rewrite `templates/.github/workflows/octestra-orchestrator.yml` as `octestra-lifecycle.yml`:
   keep `on: issues: [field_added, closed]`, inline the `transition-guard` job from the old
   `octestra-lifecycle.yml`, keep per-status routing jobs and the `finalize-merged-task` job.
   Do **not** add `workflow_dispatch`: a manual run has no `issue_field_value`, no previous status,
   and no actor type, so the whole lifecycle context would be empty. Re-driving is done by a human
   moving the status back through the state graph, which produces a real event. This is intended,
   not a gap.
2. Delete the old middle-layer `octestra-lifecycle.yml`.
3. Rename `octestra-in-progress.yml` -> `octestra-lifecycle-in-progress.yml`,
   `octestra-validation.yml` -> `octestra-lifecycle-validation.yml`.
4. Replace platform values with `vars`, with fallbacks (C6):
   - `runs-on: ${{ vars.OCTESTRA_ORCHESTRATION_RUNNER || 'ubuntu-latest' }}` / `..._AGENT_RUNNER`
   - `client-id: ${{ vars.OCTESTRA_GITHUB_APP_CLIENT_ID }}`
   - entry-point pre-runner filter:
     `format('{0}', github.event.issue_field.id) == vars.OCTESTRA_STATUS_FIELD_ID`
5. Change per-status routing to the guard's output (D5): `lifecycle/validate-transition` gains a
   `status_key` output derived from the live option ID via `status.options`; routing jobs use
   `if: needs.guard.outputs.valid == 'true' && needs.guard.outputs.status_key == 'in_progress'`.
   All seven option-ID placeholders disappear from the workflows.
6. Keep the name-based transition skip list in the entry point as-is. It is a cost optimisation and
   fails safe: a renamed option merely stops a skip from matching, starting a guard run that then
   routes correctly.
7. Give the guard a `platform-vars` input and implement the drift check (5.3).
8. Drop `github-app-client-id` and `workflow-context` from every `workflow_call` input list; the
   only remaining input is the context JSON.
9. Fix the misleading agent-secret example in `octestra-lifecycle-in-progress.yml`: show both edits
   (declare under `on.workflow_call.secrets`, pass from the caller). Do not use `secrets: inherit`
   (D10, C7).
10. Remove `replace_token`, the placeholder scan, and the client-ID prompt from `install.sh`'s
    workflow handling. Workflows now install byte-identically to `templates/`.

Verify: `bash test/install.test.sh` updated for the new tree; installed workflow files are identical
to `templates/`; `actionlint` if available.

### Phase 3 — Operation namespacing and dispatch refactor

1. Reorganise `src/` into `shared/`, `lifecycle/`, `loop/`.
2. Rename operations per section 6; add an alias table in `index.ts` emitting `core.warning`.
3. Refactor dispatch per 6.1 so an operation can run without an issue number.
4. Update `action.yml`, `README.md`, and all templates.

Verify: `make all`; existing tests pass through the aliases; a unit test asserts that an
issue-less operation name does not require `issue-number`.

### Phase 4 — Loop

1. Add `loops:` handling and validation to `src/shared/config.ts`, including the rejection of
   unbounded repository-wide selection (7.3).
2. Implement `loop/select-tasks`, `loop/prepare-run`, `loop/finalize-run`, `loop/report-failure` in
   `src/loop/`, with unit tests using the fake-client pattern in `src/operations.test.ts`. Cover:
   empty selection, malformed/missing outputs, `scan_budget` exhaustion, the 256-issue cap, PR
   exclusion, `dry_run`, and a status outside `apply.allowed_status`.
3. Resolve the ownership gap (7.5).
4. Add `templates/.github/workflows/octestra-loop-triage-todo.yml` as the per-issue fan-out
   reference, with the `select` / `agent` / `finalize` split (7.6) and its `schedule` block
   commented out — loops are opt-in.
5. Add `templates/.github/octestra/prompts/loop-triage-todo.md.hbs`.
6. Document loops in `README.md`, including C2, C3, and the fact that adding a loop means copying
   one workflow file and adding one `loops:` entry.

Verify: `make all`; a manual `workflow_dispatch` dry run in a scratch repository reports a plan and
changes nothing.

### Phase 5 — Follow-ups (not scheduled)

- Aggregate loop reference template (merged-PR retrospective producing a skill-improvement PR),
  using `branch.loop`.
- `loop/create-task` so a loop can open sub-issues under an EPIC, closing the feedback cycle.
- Apply the 7.6 job split to the lifecycle workflows, closing the `TODO.md` trust-boundary item.
- ID-based status addressing in operations (C1).
- `install.sh` hardening, including status label validation.

## 9. Sketch: `octestra-loop-triage-todo.yml`

```yaml
name: Octestra Loop - Triage Todo
run-name: "Octestra loop: triage-todo${{ inputs.dry-run && ' (dry run)' || '' }}"

on:
  # Loops are opt-in. Uncomment to enable the schedule.
  # schedule:
  #   - cron: "0 21 * * *"   # 06:00 JST daily
  workflow_dispatch:
    inputs:
      dry-run:
        description: Report the planned actions without changing any task
        type: boolean
        default: true
      config-ref:
        description: Branch to read .github/octestra/config.yml from
        type: string
        default: ""

permissions:
  contents: read
  issues: write

env:
  # `schedule` runs provide no `inputs`, where `inputs.dry-run` is falsy and this yields `false`.
  LOOP_CONTEXT: |
    {
      "loop_id": "triage-todo",
      "trigger": ${{ toJSON(github.event_name) }},
      "dry_run": ${{ inputs.dry-run || false }},
      "config_ref": ${{ toJSON(inputs.config-ref || '') }}
    }

jobs:
  select:
    runs-on: ${{ vars.OCTESTRA_ORCHESTRATION_RUNNER || 'ubuntu-latest' }}
    outputs:
      issues: ${{ steps.select.outputs.issues }}
      loop_ready: ${{ steps.select.outputs.loop_ready }}
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.OCTESTRA_GITHUB_APP_CLIENT_ID }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.repository }}
          private-key: ${{ secrets.OCTESTRA_GITHUB_APP_PRIVATE_KEY }}
      - id: select
        uses: ainame/octestra@main
        with:
          operation: loop/select-tasks
          github-token: ${{ steps.app-token.outputs.token }}
          loop-context: ${{ env.LOOP_CONTEXT }}

  # Untrusted: runs the consumer's agent. No lifecycle operation runs here.
  agent:
    needs: select
    if: needs.select.outputs.loop_ready == 'true'   # empty matrices fail (C4)
    runs-on: ${{ vars.OCTESTRA_AGENT_RUNNER || 'ubuntu-latest' }}
    permissions:
      contents: read
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        task: ${{ fromJSON(needs.select.outputs.issues) }}
    concurrency:
      group: octestra-${{ matrix.task.number }}   # same key as lifecycle task execution
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - id: loop
        uses: ainame/octestra@main
        with:
          operation: loop/prepare-run
          github-token: ${{ github.token }}       # read-only
          loop-context: ${{ env.LOOP_CONTEXT }}
          issue-number: ${{ matrix.task.number }}

      - name: Configure loop agent      # the consumer replaces this step
        run: |
          echo "::error::Replace this step with the repository's loop agent configuration."
          exit 1

      - uses: actions/upload-artifact@v4
        with:
          name: octestra-loop-triage-todo-${{ matrix.task.number }}
          path: ${{ steps.loop.outputs.result_path }}

  # Trusted: fresh token, validates the agent's document before acting.
  finalize:
    needs: [select, agent]
    if: always() && needs.select.outputs.loop_ready == 'true'
    runs-on: ${{ vars.OCTESTRA_ORCHESTRATION_RUNNER || 'ubuntu-latest' }}
    strategy:
      fail-fast: false
      matrix:
        task: ${{ fromJSON(needs.select.outputs.issues) }}
    steps:
      - uses: actions/download-artifact@v4
        continue-on-error: true
        id: result
        with:
          name: octestra-loop-triage-todo-${{ matrix.task.number }}
          path: result
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.OCTESTRA_GITHUB_APP_CLIENT_ID }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.repository }}
          private-key: ${{ secrets.OCTESTRA_GITHUB_APP_PRIVATE_KEY }}
      - if: steps.result.outcome == 'success'
        uses: ainame/octestra@main
        with:
          operation: loop/finalize-run
          github-token: ${{ steps.app-token.outputs.token }}
          loop-context: ${{ env.LOOP_CONTEXT }}
          issue-number: ${{ matrix.task.number }}
          proof-path: result/$(basename ...)      # resolve concrete filename during implementation
      - if: steps.result.outcome != 'success'
        uses: ainame/octestra@main
        with:
          operation: loop/report-failure
          github-token: ${{ steps.app-token.outputs.token }}
          loop-context: ${{ env.LOOP_CONTEXT }}
```

## 10. Resolved questions

1. **`github.event.issue_field.name` is exposed.** The entry point still filters on
   `status.field_id`; see the note in 5.2 for why the name does not reduce the variable count and is
   less stable.
2. **Manual lifecycle re-drive is out of scope.** Operators re-run work by moving the status back
   through the state graph, which produces a real Issue Field event. The lifecycle entry point
   therefore has no `workflow_dispatch`.
3. **`install.sh` hardening is deferred.** Installer work in this plan is limited to what the new
   layout requires. Label validation (C1) and any further installer improvement happen separately.
4. **`loop/finalize-run` does not create issues.** Comment, guarded status update, and no-op only.
   Issue creation stays in Phase 5.

## 11. Revision notes

Changes made after review of the first draft:

- **The central `octestra-loop.yml` router was dropped** in favour of one workflow file per loop
  (D2). Cron-string routing and the unique-cron constraint disappear with it.
- **`secrets: inherit` was reversed** (D10, C7): it contradicts the trust-boundary work.
- **Loop workflows now separate agent execution from trusted finalisation** via an artifact hand-off
  (D11, 7.6), rather than running both in one job.
- **`workflow_dispatch` was removed from the lifecycle entry point**: a manual run has no Issue
  Field event payload to build a lifecycle context from. Moved to open questions.
- **Status option IDs are no longer mirrored into `vars`** (D5). Routing now uses a status key
  emitted by the transition guard, cutting the mirrored set from eleven values to four and removing
  the largest source of drift.
- **The "byte-identical templates" claim was corrected**: `config.yml` is the one generated file,
  and installation materialises the discovered IDs into it.
- **`src/index.ts` dispatch refactor was made explicit** (6.1): it currently requires a positive
  issue number for every operation, which would break every issue-less loop operation.
- **Selection is now bounded** (7.3): pull requests excluded, `scan_budget` added, and unbounded
  repository-wide selection rejected at config validation.
- **Loop outcomes were broadened** (D12): a status update is one outcome, not the model.
- **C5 corrected**: reusable workflow nesting allows ten levels, not four.
- **C4 added**: an empty matrix fails rather than skipping.
