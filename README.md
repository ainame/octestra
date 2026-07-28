# Octestra

Octestra is a system for managing and executing AI coding tasks through GitHub.
It combines three components:

1. **GitHub Project task structure**
   Large initiatives are represented by an EPIC issue with task-specific sub-issues.
2. **Generic lifecycle and loop workflows**
   `octestra-lifecycle.yml` receives Issue Field events, validates each transition, and dispatches
   it across the task state graph. `octestra-loop-<id>.yml` files add opt-in scheduled automation
   over many tasks at once.
3. **Reusable GitHub Action operations**
   `ainame/octestra@main` provides the shared operations needed to build repository-specific
   workflows, including state updates, prompt preparation, ownership, review requests, and failure
   reporting. `ainame/octestra/proof@main` is an optional renderer for consumer-owned proof JSON.

## Requirements

Octestra must be installed in each consumer repository.

- The repository must belong to a GitHub organization because Octestra uses organization Issue
  Fields.
- [GitHub CLI](https://cli.github.com/) must be installed and authenticated.
- Creating the Issue Field requires organization administrator access. An existing compatible
  field can be reused without creating another one.
- The organization should provide a GitHub Project for the EPIC and sub-issue task structure.
- Private Octestra repositories must allow access from consumer repositories through their Actions
  access policy.

## Installation

Run the installer from the root of the consumer repository:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

The installer:

- Infers the organization from the repository
- Finds or creates the `AI Task Status` Issue Field
- Resolves the field and status option IDs
- Installs and renders the workflows and prompts
- Installs the EPIC setup skill into the selected `.claude`, `.codex`, or `.agents` directory
- Overwrites generated workflows, prompts, and the selected agent skill on every run

Use `--org` or `--status-field` to override the inferred defaults:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh |
  bash -s -- --org example-org --status-field "AI Task Status" --skill-target codex
```

The installer asks whether the generated workflows should use GitHub OIDC federation. Answer yes
when an agent assumes a cloud role, for example with
`aws-actions/configure-aws-credentials@v6` and an AWS `role-to-assume`; it enables
`id-token: write` in every generated Octestra workflow. It is unnecessary for GitHub App
authentication or static cloud credentials. Noninteractive installs leave OIDC disabled unless
`--enable-oidc` is passed; `--yes` also accepts that disabled default without prompting.

The installer also optionally records the GitHub App client ID in `.github/octestra/config.yml` and
mirrors it into the `OCTESTRA_GITHUB_APP_CLIENT_ID` repository variable.
Install that App with repository **Contents**, **Issues**, and **Pull requests** permissions set to
read and write. Leave the prompt empty to retain `YOUR-GITHUB-APP-CLIENT-ID`, or pass
`--github-app-client-id` in a noninteractive install. Store its private key as the
`OCTESTRA_GITHUB_APP_PRIVATE_KEY` GitHub Actions secret. Each generated workflow automatically
uses `github.repository_owner` and restricts the token to `github.repository` when creating its
App token. This allows access to that owner's Organization Issue Fields without installer-specific
owner configuration or access to the owner's other repositories.

After installation, customize the generated runners, agent integration, authentication, build
setup, and prompts for the consumer repository.

`.github/octestra/config.yml` keeps non-secret consumer settings together, including the GitHub App
client ID, the runner for lightweight orchestration work, and the runner for work that invokes an
agent. Edit that file and run `make octestra-sync-vars` to mirror the platform values into
repository variables. Keep `OCTESTRA_GITHUB_APP_PRIVATE_KEY` in GitHub Actions Secrets; add agent
credentials only when the chosen agent integration needs them. The workflows use an App token
instead of `GITHUB_TOKEN` so lifecycle field updates and agent pushes can trigger follow-up
workflows.

## Operations

Octestra exposes aggregate lifecycle operations for the generated workflows and individual
operations for consumers that need custom sequencing or policy.

Generated state workflows pass shared issue, status, and trigger data through named
action inputs (`issue-number`, `previous-status`, `current-status`, `trigger-actor`,
`trigger-actor-type`); the `lifecycle-context` JSON envelope is still accepted as a
fallback for consumers that prefer it. Aggregate operations infer their fixed lifecycle
behavior:

- Prompt paths default by phase.
- `finalize-task` reads the EPIC configuration to choose Validation or Human Review.
- `finalize-validation` moves passed results to Human Review and other results to Blocked.
- `report-failure` derives the workflow run URL and moves the task to Blocked.
- Proof reporting derives the checked-out commit SHA from the workspace.

Each EPIC's required `epic-config.id` is a lowercase slug that namespaces its task branches. The
generated lifecycle workflow reads the default branch template from `.github/octestra/config.yml`;
its default is `octestra/{epic_id}/issue-{issue_number}`. `prepare-task` exposes the resolved `branch_name` for
any task agent to use directly, while `finalize-task` and `prepare-validation` independently
resolve the same branch. For Claude Code Action, pass `branch_name` as `branch_prefix` with
`branch_name_template: "{{prefix}}"`. `epic-config.skill` is optional and is reserved for
agent-specific capability selection.

Before task execution, `prepare-task` checks the expected branch and every linked open pull
request. If either exists, it moves the task to `Blocked`, posts an activity comment mentioning
the task owner, and sets `task_ready` to `false`; the generated workflow skips the agent and
finalization steps. Close the existing PR, delete its source branch, then move the task through
`Ready` to `In Progress` to retry.

The generated orchestrator also listens for issue closure. It first ignores issues without an
`AI Task Status` of `Human Review`. When GitHub closes a remaining issue within one minute of a
linked pull request merging, Octestra moves its status to `Done`. It also ignores manually closed
issues and closures unrelated to a merged pull request.

| Type | Operation | Behavior |
|---|---|---|
| Guard | `validate-transition` | Validates the observed state transition against the live issue state; an invalid human transition assigns and warns its triggering user without changing status. |
| Aggregate | `prepare-task` | Assigns the task owner, blocks existing task branch or linked PR work, otherwise builds task context, renders the task prompt, and configures the Git co-author trailer. |
| Aggregate | `finalize-task` | Resolves the task branch and pull request, assigns the task owner to the pull request, optionally requests review, updates status, and records task activity. |
| Aggregate | `prepare-validation` | Builds validation context, resolves the linked pull request, renders the validation prompt, and provides the result path. |
| Aggregate | `finalize-validation` | Reports proof and, for a passed result, assigns the task owner to the pull request, requests review, and moves the task to the configured success status; other outcomes move to the failure status. |
| Aggregate | `finalize-merged-task` | Moves a `Human Review` task to `Done` when GitHub closes it as part of a linked pull request merge. |
| Individual | `assign-owner` | Assigns the user who triggered the task transition while preserving the existing owner for bot transitions. |
| Individual | `assign-pr-owner` | Assigns the latest human Issue task owner to the task pull request. |
| Individual | `build-task-context` | Loads task and EPIC configuration, renders the task prompt, configures co-authorship, and publishes task outputs. |
| Individual | `build-validation-context` | Loads task and EPIC configuration, resolves the linked pull request, renders the validation prompt, and publishes validation outputs. |
| Individual | `resolve-task-pr` | Resolves the open pull request for a task branch and publishes its number. |
| Individual | `report-proof` | Renders consumer-owned proof JSON as a reviewer-focused issue comment without changing lifecycle status. |
| Individual | `request-review` | Ensures the latest human Issue task owner is assigned to the pull request, then requests review from that owner. |
| Individual | `update-status` | Updates the configured organization Issue Field to the requested status. |
| Failure | `report-failure` | Records workflow failure details and moves the task to the configured failure status. |

## Proof reporting

`ainame/octestra/proof@main` is a convenient wrapper around the individual `report-proof` operation.
It reads a consumer-generated JSON file, posts a concise table-based issue comment, and exposes the
reported outcome. Acceptance criteria, checks, and evidence remain consumer-owned.

```yaml
- name: Report validation proof
  id: proof
  uses: ainame/octestra/proof@main
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    issue-number: ${{ inputs.issue-number }}
    proof-path: ${{ steps.prepare.outputs.result_path }}
    pull-number: ${{ steps.prepare.outputs.pull_number }}
```

The default convention requires only `outcome` and `summary`. Optional `acceptance`, `checks`,
`evidence`, `artifacts`, `knownGaps`, and Markdown `details` are rendered when present. Unknown
top-level fields are ignored so repositories can extend the document. Technical workflow metadata
and long-form details are collapsed with `<details>` to keep the reviewer-facing result prominent.

The generated `octestra-lifecycle-validation.yml` uses `lifecycle/finalize-validation` for the
default policy:
`passed` reports proof, requests review, and moves the task to Human Review, while other outcomes
report proof and move it to Blocked. A consumer can replace that aggregate with the individual
operations above without reimplementing the underlying GitHub behavior.

## Loops

Loops are opt-in scheduled automation over many tasks at once. Add a `loops.<id>` entry to
`.github/octestra/config.yml` and copy the matching `octestra-loop-<id>.yml` workflow. Schedules run
only from the default branch, are best-effort, and may be disabled after repository inactivity, so
every loop must be idempotent — use `select.updated_before` to skip recently touched issues. Each
loop also exposes `workflow_dispatch`, which defaults to a dry run.

A loop selects issues, runs the consumer's agent once per issue (or once for the whole set), and
then applies the result from a separate trusted job. What it may do is bounded by
`apply.allowed_status`, `select.limit`, and `select.scan_budget`. A loop that changes a task's
status emits a normal Issue Field event, so the lifecycle observes it and nothing bypasses the state
machine.

Two reference templates ship, and between them cover both shapes:

- `octestra-loop-triage-todo.yml` **fans out** — one agent job per selected issue, via a matrix. The
  agent comments on its issue and may request a status from `apply.allowed_status`.
- `octestra-loop-retrospective.yml` **aggregates** — one agent job reads the whole selected set and
  changes no task state. Because it produces code, the untrusted agent job only writes a patch; the
  trusted finalize job applies it, pushes the branch from `branch.loop`, and opens a pull request.

Copy whichever is closer to what you want and edit it. The operations are the same either way; the
shape follows from whether the workflow passes an issue number to `loop/prepare-run`.

### Configuration control plane

Installation creates `.github/octestra/config.yml`, the source of truth for platform values,
status option IDs, branch templates, prompt paths, and loop policy. Four values are mirrored into
repository variables: `OCTESTRA_GITHUB_APP_CLIENT_ID`, `OCTESTRA_ORCHESTRATION_RUNNER`,
`OCTESTRA_AGENT_RUNNER`, and `OCTESTRA_STATUS_FIELD_ID`. Run `make octestra-check-vars` to detect
drift and `make octestra-sync-vars` to apply them. Prompts are read from the checkout under
`.github/octestra/prompts`; the deprecated `workflow-context` and `prompt-template` inputs remain
overrides for one release.

Installed workflows are `octestra-lifecycle.yml`, lifecycle in-progress/validation reusable
workflows, and opt-in `octestra-loop-<id>.yml` files. Lifecycle operations use the
`lifecycle/<verb>` namespace and loop operations use `loop/<verb>`; old lifecycle names are
deprecated aliases.

## Development

```sh
npm ci
make all
```

`dist/index.js` and `proof/dist/index.js` are committed because they are the GitHub Actions runtime
bundles.

`AGENTS.md` is the contract for changing this repository: layout, platform invariants, code style,
and the review checklist. `docs/design.md` records why the system is shaped the way it is, and
`TODO.md` tracks open work.
