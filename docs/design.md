# Octestra design

Why the system is shaped the way it is. `AGENTS.md` states the rules; this file states the
reasoning behind them, so that a future change can tell a deliberate constraint from an accident.

## 1. Two systems, one action surface

Octestra runs AI coding agents against GitHub issues. Work reaches an agent one way: an
`issues: [field_added, closed]` event enters `octestra-lifecycle.yml`, which owns the task state
graph — one event, one task.

Scheduled loops are intentionally thinner. A consumer-owned workflow chooses the schedule, prompt
and agent. Octestra discovers its open EPIC configuration units, honors their opt-out, renders the
prompt, and publishes stable output paths. The repository's triage skill owns task discovery,
selection, domain readiness policy and issue preparation. Octestra validates the fully processed
issue numbers before it exclusively moves eligible tasks from `Todo` to `Ready`.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D3 | Platform values (runner labels, App client ID, status field ID) live in repository `vars` | `vars` is available in `runs-on`, job `if`, `with`, `concurrency`, and `run-name`; `env` is available in none of them (P2). |
| D4 | The lifecycle is one workflow | Repository variables let each status job select its runner directly, and local composite actions now hold the consumer-owned agent policy. Separate reusable workflows add files and caller/callee wiring without preserving a useful boundary. |
| D5 | Per-status routing keys on a `status_key` output from the transition guard, not on per-status values in workflow YAML | The guard already runs for every routed event, so this costs nothing and keeps seven values out of `vars`. |
| D6 | `config.yml` is the source of truth and the only file `install.sh` generates — once, and never again | One reviewable, version-controlled file keeps per-consumer values out of the managed workflow. Regenerating it on a rerun would reset every value the consumer edited, so an existing file is kept and contradictions are reported (D14). |
| D7 | The status *field* is addressed by ID; a status *option* is addressed by its display name | A field rename must not break routing, and `field_id` is available to the guard through a variable. Option IDs cannot be used the same way: the write endpoint accepts a single_select value only as the option name, so an option ID would buy nothing while adding a second vocabulary. See P1 and `TODO.md` §2. |
| D8 | Prompts live in `.github/octestra/prompts/` | Everything Octestra owns in a consumer repository sits under one directory. |
| D9 | Operations are namespaced `lifecycle/<verb>`, `loop/<verb>`, bare for scope-neutral | Verb-first naming survives inside each namespace, and `src/lifecycle/`, `src/loop/`, `src/shared/` map 1:1. |
| D11 | `install.sh` rewrites the workflow's `uses:` references: a fork tracks its own default branch, upstream is pinned to its newest version tag | A consumer who forks Octestra does so to execute only code their own organization controls, and their fork's default branch is the thing they update deliberately — pinning it to a tag would add a second step to every upgrade without adding a guarantee. An upstream install gets a tag instead, so the code a consumer runs cannot change between two installs. The template still ships `@main` because it must be runnable as committed, which makes this a rewrite of a valid value rather than placeholder substitution. |
| D12 | Maintenance lives in `.github/octestra/octestra.sh`, installed into the consumer repository, and `install.sh` uses that copy for the initial variable sync | Mirroring, drift detection and ref switching are things a consumer does *after* installation, from their own checkout — a `make` target in this repository was documented but unreachable there. Installing the tool also removes the second implementation: one script owns config → variables, and every install exercises it. It needs only `gh`, because a consumer repository is not required to have node. |
| D13 | A finished task PR is opened ready for review, is taken out of draft before review is requested, and gets no assignee; the EPIC opts out with `draft_pr: true` and out of validation with `skip_validation: true`, both defaulting to `false` | Every default here is the state a human wants at the moment they are asked to look. Marking a PR ready by hand is friction repeated on every task, and where validation runs the work has already been checked before a human sees it — so *ready* is the honest state, and requesting review on something GitHub labels a draft is a contradiction rather than a workflow. `skip_validation` is spelled as the exception it is: the negative name (`validation_required: false`) read as the normal case while describing the opt-out, and inverting it puts "run validation" in the default. The PR assignee was dropped because it duplicates the issue assignee while adding a second mobile notification for the same person. |
| D14 | The installed workflow is replaced in full; consumer-owned composite actions and `config.yml` are preserved in full; `octestra.sh update` drives the process by running the target version's own `install.sh` | The lifecycle workflow is mechanism that Octestra must be able to update coherently. Agent actions are policy: every line expresses how the consumer's agent runs, so there is no useful Octestra-owned remainder to merge. Keeping each file wholly on one side removes a merge protocol and makes update behavior explicit. Delegating to the downloaded `install.sh` keeps one implementation and means an update runs the new logic rather than whatever the consumer installed months ago. |
| D15 | Lifecycle preparation, repository-defined agent execution, and finalization share one job and runner; the repository-defined steps live in local composite actions | Preparation publishes runtime state that the agent consumes immediately, so another job would start another runner only to reconstruct the same workspace and environment. A composite action provides a boundary inside the existing job; for task execution, the workflow also checks `task_ready` once so every setup and agent step inside the action is skipped together. |
| D16 | The loop kernel discovers enabled EPIC configuration units and renders a consumer-selected prompt for each | The `octestra-epic` label and `epic-config` are Octestra contracts, so enumerating them and honoring `skip_triage` is mechanism. Task selection, limits, domain knowledge and issue preparation stay in a repository-owned triage skill and preserved local action. |
| D17 | One framework-owned `/octestra-contracts` skill defines the task, triage and validation phase contracts | Every agent needs the same workflow protocol while repository skills own domain policy. Updating one installed framework skill avoids protocol drift and removes the validation-only second source of truth. |
| D18 | Triage agents report fully processed issue numbers; `loop/finalize-triage` owns status mutation and activity reporting | Repository triage may prepare issue bodies and other issue data, but agent-selected numbers remain untrusted and agents never update the status field. Finalization requires one valid result, preflights every task and the parent EPIC before any status write, accepts only direct open task sub-issues currently in `Todo` or `Ready`, and rechecks status immediately before each `Todo` to `Ready` update. Immediately before an actual update it posts the same best-effort Octestra activity record used by lifecycle finalizers, linking the task, source EPIC and workflow run; already-`Ready` tasks produce neither a write nor a duplicate activity. |

### Local composite action trade-offs

The task, validation and triage composite actions run as ordinary steps in their calling jobs. They therefore
share its runner instance, operating system, workspace and environment. Consumer-owned actions may
perform runner-specific setup such as selecting Xcode, installing Homebrew packages or configuring
Ruby, and may branch on `runner.os`. The parent job still chooses the runner through
`OCTESTRA_AGENT_RUNNER`.

This boundary has deliberate limitations:

- A composite action cannot select `runs-on` or declare job permissions, timeouts, concurrency,
  services or containers. Those remain properties of the calling workflow job.
- A composite action cannot read the `secrets` context directly. Agent credentials therefore use
  OIDC or come from the configured runner's environment.
- It is an organization boundary, not a security boundary. The action shares the job's token,
  permissions, environment and writable workspace.
- GitHub Actions displays the action as one outer workflow step. Its nested steps retain separate
  logs, but the workflow graph is less direct than listing every step inline.
- A repository-local action exists only after checkout. All agent jobs already check out the
  consumer repository before invoking their local action, so this adds no second clone or checkout.
- Every composite `run` step must declare its shell.
- An installed composite action receives no later template improvements automatically because the
  entire file belongs to the consumer. Workflow changes must remain compatible with older action
  files; a consumer adopts action-template changes manually.

### Rejected alternatives

- **A bootstrap job that reads `config.yml` and fans values out through `needs.*.outputs`.** The
  lifecycle entry point deliberately filters most Issue Field events with a job-level `if` that
  costs no runner minutes; a bootstrap job would start a runner for every unrelated field change.
- **One workflow file per lifecycle status, each with its own `on: issues` trigger** — routing by
  filename instead of by a guard output (D5). Rejected because every field change would create a
  workflow *run record* per file. Cost stays zero but the Actions tab becomes unreadable.

## 3. Configuration model

Split by *when* a value is needed, not by what it is.

| Tier | Examples | Lives in | Why not elsewhere |
|---|---|---|---|
| Platform | runner labels, App client ID, private-key secret name, status field ID | `config.yml`, mirrored to `vars` | Needed before a job starts; no file can be read then |
| Policy | status field name, branch templates, prompt paths | `config.yml`, read at runtime | Reviewable and versioned |
| Wiring | trigger filters, job graph, agent invocation | workflow YAML | GitHub accepts only literals here; also the consumer's customisation surface |
| Intent | EPIC and task issue body blocks | issue body | Unchanged |

Loop configuration does not add another tier. An EPIC's `epic-config` controls whether Todo triage
runs and which skill it invokes. The loop workflow remains the reviewable source for its schedule,
permissions, concurrency and agent wiring.

### Mirrored values

| `vars` name | `config.yml` path | Used by |
|---|---|---|
| `OCTESTRA_GITHUB_APP_CLIENT_ID` | `github_app.client_id` | `create-github-app-token` in the lifecycle workflow |
| `OCTESTRA_GITHUB_APP_PRIVATE_KEY_SECRET` | `github_app.private_key_secret_key_name` | the secret lookup in every App-token step |
| `OCTESTRA_ORCHESTRATION_RUNNER` | `runners.orchestration` | `runs-on` |
| `OCTESTRA_AGENT_RUNNER` | `runners.agent` | `runs-on` |
| `OCTESTRA_STATUS_FIELD_ID` | `status.field_id` | the entry point's pre-runner `if` |

The `field_added` payload does expose `github.event.issue_field.name`, so the entry point could
filter on the field name instead. It does not: the name would still have to come from a variable
because the workflow template carries no placeholders — a per-consumer field name written into workflow
YAML would be one (D11 rewrites a valid value, which is a different thing) — so the variable count
is unchanged, and the ID survives a field rename while the name does not (D7).

Status option IDs are not carried at all (D7): every operation names a status by its display name,
so `config.yml` records only `field_name` and `field_id`. `install.sh` verifies at setup that the
organization's field has all seven required options.

### Drift

Mirroring creates a window where `vars` and `config.yml` disagree. It is contained by:

1. **A small surface.** Five values, four of which change approximately never.
2. **No chicken-and-egg.** Runner labels have literal fallbacks (P3), so the guard can start even
   when its own variable is unset.
3. **A local check.** `.github/octestra/octestra.sh vars check` exits non-zero on drift,
   `vars sync` applies, and `doctor` reports both drift and an unset variable in context;
   `install.sh` runs that same installed script to sync at the end of installation (D12).

A runtime drift check inside `lifecycle/validate-transition` was scoped but never implemented — the
`platform-vars` input that would have carried the five values does not exist, and the local check
plus install-time sync have covered the actual failure mode in practice. If a runtime check is
added later, it belongs in the guard job so it runs on every routed event with no extra job.
