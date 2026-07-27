# Octestra design

Why the system is shaped the way it is. `AGENTS.md` states the rules; this file states the
reasoning behind them, so that a future change can tell a deliberate constraint from an accident.

## 1. Two systems, one control plane

Octestra runs AI coding agents against GitHub issues. Work reaches an agent two ways:

| | Lifecycle | Loop |
|---|---|---|
| Trigger | `issues: [field_added, closed]` | `schedule` + `workflow_dispatch` |
| Cardinality | one event, one task | one schedule, many tasks |
| Entry point | `octestra-lifecycle.yml` | `octestra-loop-<id>.yml`, one per loop |
| Owns | the task state graph | selection policy and cadence |

Motivating loops:

| Loop | Cadence | Shape | Outcome |
|---|---|---|---|
| Triage tasks sitting in `Todo` | daily | one agent run per issue | comment, promote to `Ready` |
| Diagnose tasks stuck in `Blocked` | weekly | one agent run per issue | comment, remind, sometimes promote |
| Retrospective on merged task PRs | when enough accumulate | one agent run for the whole set | open a skill-improvement PR |

A loop outcome is one of: comment or report, guarded status update, open a pull request, or no-op.
A status update is *an* outcome, not the model — reminders and retrospectives do not map onto a
transition. When a loop does change status the lifecycle observes the resulting event normally, so
nothing bypasses the state machine.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Loop is a separate entry point, never a `schedule` trigger added to the lifecycle entry point | The lifecycle entry point keys `concurrency.group`, `run-name`, and its routing `if` on `github.event.issue.number`, which is empty on `schedule`. Every scheduled run would collapse into one concurrency group. |
| D2 | One workflow file per loop, with no central loop router | The only thing a router would have shared is configuration, and D3 removes that need. A router forces routing by `github.event.schedule` string, requiring globally unique cron strings and duplicating each loop's identity across cron condition, dispatch choice list, job name, context JSON, and filename. |
| D3 | Platform values (runner labels, App client ID, status field ID) live in repository `vars` | `vars` is available in `runs-on`, job `if`, `with`, `concurrency`, and `run-name`; `env` is available in none of them (P2). |
| D4 | The lifecycle is two workflow layers, not three | The old middle layer existed only to convert workflow `env` into `workflow_call` inputs so `runs-on` could read it. D3 removes that need. |
| D5 | Per-status routing keys on a `status_key` output from the transition guard, not on option IDs in workflow YAML | The guard already runs for every routed event, so this costs nothing, keeps option IDs authoritative in `config.yml`, and removes seven values from `vars`. |
| D6 | `config.yml` is the source of truth and the only file `install.sh` generates | One reviewable, version-controlled file. Placeholder substitution collapses from many workflow files to one. |
| D7 | Status option IDs are the authoritative identity of a status | Consumers may rename labels; IDs are stable. See P1. |
| D8 | Prompts live in `.github/octestra/prompts/` | Everything Octestra owns in a consumer repository sits under one directory. |
| D9 | Operations are namespaced `lifecycle/<verb>`, `loop/<verb>`, bare for scope-neutral | Paired operations get identical names (`lifecycle/report-failure` ↔ `loop/report-failure`), verb-first naming survives inside each namespace, and `src/lifecycle/`, `src/loop/`, `src/shared/` map 1:1. |
| D10 | Never `secrets: inherit` | It hands every repository and organization secret to a workflow that executes an agent, contradicting the trust boundary. See P7. |
| D11 | Loop workflows separate the agent job from a trusted finalize job, handing results over as a bounded artifact | Loops run unattended on a schedule, the worst place to keep agent execution and privileged writes in one job. This also pilots the pattern the lifecycle should adopt. |

### Rejected alternatives

- **A single `octestra-loop.yml` bundling every loop** (the original idea). Its motivation was
  sharing one `env` anchor block. `vars` removes that motivation, and bundling then costs
  cron-string routing plus five places per loop that must agree. See D2.
- **A single `tick` cron driving loops from a data file.** `on.schedule.cron` accepts only YAML
  literals, so per-loop cadence would need persisted last-run state. GitHub's cron delivery is
  already delayed and skippable (P5); a second scheduler on top makes failure unobservable.
- **A bootstrap job that reads `config.yml` and fans values out through `needs.*.outputs`.** The
  lifecycle entry point deliberately filters most Issue Field events with a job-level `if` that
  costs no runner minutes; a bootstrap job would start a runner for every unrelated field change.
- **One workflow file per lifecycle status, each with its own `on: issues` trigger** — perfect
  symmetry with D2. Rejected because every field change would create a workflow *run record* per
  file. Cost stays zero but the Actions tab becomes unreadable.

### On the lifecycle/loop asymmetry

The lifecycle has two layers and a loop has one. This is derived from trigger cardinality, not
accident: a single event stream needs one demultiplexer, whereas independent cron triggers do not.
What *is* symmetric is naming (`octestra-<system>[-<unit>].yml`), directory layout, operation
namespaces, and the rule that the file carrying the trigger owns the policy.

## 3. Configuration model

Split by *when* a value is needed, not by what it is.

| Tier | Examples | Lives in | Why not elsewhere |
|---|---|---|---|
| Platform | runner labels, App client ID, status field ID | `config.yml`, mirrored to `vars` | Needed before a job starts; no file can be read then |
| Policy | status field name, option IDs, branch templates, prompt paths, loop selection and guard rails | `config.yml`, read at runtime | Reviewable and versioned |
| Wiring | cron strings, job graph, agent invocation | workflow YAML | GitHub accepts only literals here; also the consumer's customisation surface |
| Intent | `epic-config`, `task-config` | issue body | Unchanged |

### Mirrored values

| `vars` name | `config.yml` path | Used by |
|---|---|---|
| `OCTESTRA_GITHUB_APP_CLIENT_ID` | `github_app.client_id` | `create-github-app-token` in reusable workflows |
| `OCTESTRA_ORCHESTRATION_RUNNER` | `runners.orchestration` | `runs-on` |
| `OCTESTRA_AGENT_RUNNER` | `runners.agent` | `runs-on` |
| `OCTESTRA_STATUS_FIELD_ID` | `status.field_id` | the entry point's pre-runner `if` |

The `field_added` payload does expose `github.event.issue_field.name`, so the entry point could
filter on the field name instead. It does not: the name would still have to come from a variable
because workflow templates install byte-identically, so the variable count is unchanged, and the ID
survives a field rename while the name does not (D7).

Status option IDs are deliberately not mirrored (D5) — only the transition guard consumes them, and
it reads `config.yml` directly.

### Drift

Mirroring creates a window where `vars` and `config.yml` disagree. It is contained by:

1. **A small surface.** Four values, three of which change approximately never.
2. **Loud failure.** `lifecycle/validate-transition` takes a `platform-vars` input carrying the four
   values, compares them against `config.yml`, and fails with a diff. The guard already runs on
   every routed event, so this needs no extra job.
3. **No chicken-and-egg.** Runner labels have literal fallbacks (P3), so the guard can start and
   report the problem even when its own variable is unset.
4. **A local check.** `make octestra-check-vars` exits non-zero on drift; `make octestra-sync-vars`
   applies; `install.sh` syncs at the end of installation.

## 4. Loop contract

### `loop-context`

Peer of `lifecycle-context`: one JSON input carrying the run's identity. Selection policy and guard
rails stay in `config.yml`, so changing policy does not mean editing workflow wiring.

```jsonc
{
  "loop_id": "triage-todo",
  "trigger": "schedule",     // or "workflow_dispatch"
  "dry_run": false,          // OR-ed with loops.<id>.apply.dry_run
  "config_ref": ""           // empty means default branch
}
```

A run can force a dry run that the config did not ask for; it can never force a wet run against a
loop that `config.yml` pinned to `dry_run: true`. Guard rails only tighten.

### Operations

| Operation | Outputs | Behaviour |
|---|---|---|
| `loop/select-tasks` | `issues`, `count`, `digest`, `loop_ready`, `partial` | Resolves `loops.<id>.select`. `loop_ready` is `'false'` for an empty array; both outputs derive from the same validated array (P6). `partial` is `'true'` when `scan_budget` was reached. |
| `loop/prepare-run` | `prompt`, `result_path`, `artifact_path`, `patch_path`, `branch_name` | Renders `loops.<id>.prompt`. Fan-out mode receives one issue number; aggregate mode receives the whole selected set plus a run-scoped branch name derived from `branch.loop`. |
| `loop/finalize-run` | `outcome`, `applied` | Validates the agent's result document, comments, and applies the requested `next_status` only when it appears in `apply.allowed_status`. Reports to `report_issue` when no issue number is given. Dry run reports without applying, and is the union of the run's `dry_run` and `apply.dry_run`. |
| `loop/report-failure` | | Peer of `lifecycle/report-failure`. A loop has no task to block, so it comments on `report_issue` when configured and otherwise fails the step. |

`next_status` is deliberately a separate field from the proof document's `outcome`: `outcome`
describes the analysis (`passed`, `blocked`, `no_action`) and `next_status` requests a state change.
Conflating them means comparing two vocabularies that can never match.

### Selection

There is no dependable Issue Field search qualifier today, so `loop/select-tasks`:

1. lists sub-issues of `select.epic` when set, otherwise open issues narrowed by `select.labels`,
   excluding pull requests (the issues endpoint returns both);
2. reads `issue-field-values` per candidate and filters by `select.status`;
3. applies `updated_before`, `order`, then `limit`.

Step 2 is an N+1 scan and `limit` bounds only the result, so:

- repository-wide selection (`epic: null` and `labels: []`) is **rejected** by config validation;
- `scan_budget` caps candidates examined independently of `limit`, bounding pagination itself.
  Reaching it sets `partial` and is surfaced in `digest`; it is not an error, because P5 means the
  next run picks up the rest.

Keeping this inside one operation means a future search qualifier changes the operation, not the
workflow contract.

### Guard rails

- `select.limit` and `select.scan_budget` are required, with small defaults.
- `select.updated_before` skips recently touched issues. This is the idempotency guard P5 demands.
- `strategy.max-parallel` defaults small in the templates.
- Per-issue jobs use `concurrency.group: octestra-<issue_number>`, the same key as
  `octestra-lifecycle-in-progress.yml`, so a loop cannot run against a task that is mid-execution
  (P8).
- `apply.allowed_status` bounds what a loop may do. Templates default to `Ready` and `Blocked`;
  promoting straight to `In Progress` would start many agent runs at once.
- `workflow_dispatch` defaults `dry-run` to `true` (P4).

### Two loop shapes

The same four operations cover both reference templates. The shape is chosen by whether
`loop/prepare-run` is given an issue number, not by a mode flag.

| | Fan-out (`octestra-loop-triage-todo.yml`) | Aggregate (`octestra-loop-retrospective.yml`) |
|---|---|---|
| Agent jobs | One per selected issue, via `strategy.matrix` | One, for the whole set |
| Prompt sees | `issueNumber` | `issues`, `issueCount`, `branchName`, `patchPath` |
| Result target | The issue itself | `report_issue` |
| `apply.allowed_status` | The statuses the loop may set | `[]` — an aggregate run changes no task state |
| Output | Comments and status writes | A pull request |

Aggregate loops answer questions no single issue can: "what do the last twenty merged tasks say
about our skills?" They therefore need to *write code*, which the agent job must not be trusted to
push. So the hand-off is a patch:

1. The agent job produces `git diff --binary > $patch_path` and uploads it with the result document.
2. The `finalize` job — trusted, App token, fresh checkout — applies the patch, pushes the
   run-scoped branch from `branch.loop`, and opens a pull request.

Nothing merges automatically; review stays human. The residual risk is that a patch touches
`.github/workflows/`, which GitHub rejects for tokens without the `workflows` permission, and which
a reviewer would see in the diff regardless.

`branch.loop` is the only place the run number is needed, so `loop/prepare-run` resolves the branch
name rather than making each template re-derive it.

### Trust boundary

Every loop workflow has three jobs:

1. `select` — trusted, no checkout of agent-modifiable content, orchestration runner.
2. `agent` — runs the consumer's agent. Checks out with `persist-credentials: false`, receives only
   explicitly declared credentials, writes a result document, uploads it as an artifact named per
   matrix leg. **No lifecycle operation runs here.**
3. `finalize` — trusted. Downloads the artifact, mints a fresh App token, and runs
   `loop/finalize-run`, which strictly validates the document before acting.

This is stricter than the lifecycle workflows, which still run `finalize-task` in the agent job.
That gap is tracked in `TODO.md`; the pattern here is the intended migration target.
