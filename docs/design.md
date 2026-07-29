# Octestra design

Why the system is shaped the way it is. `AGENTS.md` states the rules; this file states the
reasoning behind them, so that a future change can tell a deliberate constraint from an accident.

## 1. One system, one control plane

Octestra runs AI coding agents against GitHub issues. Work reaches an agent one way: an
`issues: [field_added, closed]` event enters `octestra-lifecycle.yml`, which owns the task state
graph — one event, one task.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D3 | Platform values (runner labels, App client ID, status field ID) live in repository `vars` | `vars` is available in `runs-on`, job `if`, `with`, `concurrency`, and `run-name`; `env` is available in none of them (P2). |
| D4 | The lifecycle is two workflow layers, not three | The old middle layer existed only to convert workflow `env` into `workflow_call` inputs so `runs-on` could read it. D3 removes that need. |
| D5 | Per-status routing keys on a `status_key` output from the transition guard, not on per-status values in workflow YAML | The guard already runs for every routed event, so this costs nothing and keeps seven values out of `vars`. |
| D6 | `config.yml` is the source of truth and the only file `install.sh` generates | One reviewable, version-controlled file. Placeholder substitution collapses from many workflow files to one. |
| D7 | The status *field* is addressed by ID; a status *option* is addressed by its display name | A field rename must not break routing, and `field_id` is available to the guard through a variable. Option IDs cannot be used the same way: the write endpoint accepts a single_select value only as the option name, so an option ID would buy nothing while adding a second vocabulary. See P1 and `TODO.md` §3. |
| D8 | Prompts live in `.github/octestra/prompts/` | Everything Octestra owns in a consumer repository sits under one directory. |
| D9 | Operations are namespaced `lifecycle/<verb>`, `loop/<verb>`, bare for scope-neutral | Paired operations get identical names (`lifecycle/report-failure` ↔ `loop/report-failure`), verb-first naming survives inside each namespace, and `src/lifecycle/`, `src/loop/`, `src/shared/` map 1:1. The `loop/` namespace and `src/loop/` are kept unused: they return when loops do (`TODO.md` §1). |
| D10 | Never `secrets: inherit` | It hands every repository and organization secret to a workflow that executes an agent, contradicting the trust boundary. See P7. |
| D11 | `install.sh` rewrites the `uses:` reference in the workflows it installs: a fork tracks its own default branch, upstream is pinned to its newest version tag | A consumer who forks Octestra does so to execute only code their own organization controls, and their fork's default branch is the thing they update deliberately — pinning it to a tag would add a second step to every upgrade without adding a guarantee. An upstream install gets a tag instead, so the code a consumer runs cannot change between two installs. Templates still ship `@main` because a template must be runnable as committed, which makes this a rewrite of a valid value rather than placeholder substitution. |
| D12 | Maintenance lives in `.github/octestra/octestra.sh`, installed into the consumer repository, and `install.sh` uses that copy for the initial variable sync | Mirroring, drift detection and ref switching are things a consumer does *after* installation, from their own checkout — a `make` target in this repository was documented but unreachable there. Installing the tool also removes the second implementation: one script owns config → variables, and every install exercises it. It needs only `gh`, because a consumer repository is not required to have node. |
| D13 | A finished task PR is opened ready for review, is taken out of draft before review is requested, and gets no assignee; the EPIC opts out with `draft_pr: true` and out of validation with `skip_validation: true`, both defaulting to `false` | Every default here is the state a human wants at the moment they are asked to look. Marking a PR ready by hand is friction repeated on every task, and where validation runs the work has already been checked before a human sees it — so *ready* is the honest state, and requesting review on something GitHub labels a draft is a contradiction rather than a workflow. `skip_validation` is spelled as the exception it is: the negative name (`validation_required: false`) read as the normal case while describing the opt-out, and inverting it puts "run validation" in the default. The PR assignee was dropped because it duplicates the issue assignee while adding a second mobile notification for the same person. |

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
| Platform | runner labels, App client ID, status field ID | `config.yml`, mirrored to `vars` | Needed before a job starts; no file can be read then |
| Policy | status field name, branch templates, prompt paths | `config.yml`, read at runtime | Reviewable and versioned |
| Wiring | trigger filters, job graph, agent invocation | workflow YAML | GitHub accepts only literals here; also the consumer's customisation surface |
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
because workflow templates carry no placeholders — a per-consumer field name written into workflow
YAML would be one (D11 rewrites a valid value, which is a different thing) — so the variable count
is unchanged, and the ID survives a field rename while the name does not (D7).

Status option IDs are not carried at all (D7): every operation names a status by its display name,
so `config.yml` records only `field_name` and `field_id`. `install.sh` verifies at setup that the
organization's field has all seven required options.

### Drift

Mirroring creates a window where `vars` and `config.yml` disagree. It is contained by:

1. **A small surface.** Four values, three of which change approximately never.
2. **No chicken-and-egg.** Runner labels have literal fallbacks (P3), so the guard can start even
   when its own variable is unset.
3. **A local check.** `.github/octestra/octestra.sh vars check` exits non-zero on drift,
   `vars sync` applies, and `doctor` reports both drift and an unset variable in context;
   `install.sh` runs that same installed script to sync at the end of installation (D12).

A runtime drift check inside `lifecycle/validate-transition` was scoped but never implemented — the
`platform-vars` input that would have carried the four values does not exist, and the local check
plus install-time sync have covered the actual failure mode in practice. If a runtime check is
added later, it belongs in the guard job so it runs on every routed event with no extra job.
