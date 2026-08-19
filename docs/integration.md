# Octestra Integration Guide

📖 [日本語](integration.ja.md)

This guide explains how to connect implementation and validation agents to an installed Octestra instance and define task issues. For installation, updates, and maintenance, see the [README](../README.md).

## Task Lifecycle

Octestra creates an `AI Task Status` Issue Field in the organization. Changing a status option of this field on a task issue runs a workflow.

```text
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
             ▲            │                              ▲
             │            └──────────────────────────────┘  when skip_validation is true
             └──────────── Blocked ◀──── any failure above
```

| Status | Behavior |
|---|---|
| `Todo` | The task has been created. |
| `Ready` | The task is ready to start a GitHub workflow. |
| `In Progress` | The `in-progress` job in `octestra-lifecycle.yml` runs the implementation agent. |
| `Validation` | The `validation` job in `octestra-lifecycle.yml` runs the validation agent. |
| `Human Review` | Requests pull request review from the task owner. |
| `Blocked` | Comments with the failure and a link to the Actions run. Move the task back to `Ready` to retry. |
| `Done` | The task is complete. |

Organize related task issues under an EPIC issue. An EPIC issue is the parent issue whose `epic-config` block supplies shared configuration for its task issues. A task issue is one unit of agent work and a sub-issue of an EPIC.

## Define EPIC and Task Issues

An issue-body contract is the Markdown template defining the fenced blocks in an EPIC or task issue. Create EPIC issues from `.github/octestra/issue-templates/epic.md.hbs` and task issues from `.github/octestra/issue-templates/task.md.hbs`. Do not use a different issue body format.

An EPIC issue contains settings and instructions shared by all of its task issues.

````markdown
```epic-config
id: ios-swift6            # lowercase identifier used in task branch names
task_skill: swift-concurrency       # optional skill used by the task agent
triage_skill: migration-triage      # required when using the Todo triage loop
validation_skill: ios-ui-validation # required unless validation is skipped
draft_pr: false           # whether to open each task pull request as a draft
skip_triage: false        # when true, exclude this EPIC from triage
skip_validation: false    # when true, move directly to Human Review
```

```epic-task-prompt
Instructions shared by every task in this EPIC.
```

```epic-triage-prompt
Optional instructions for Todo triage in this EPIC.
```

```epic-validation-prompt
Optional instructions for the validation agent shared by this EPIC's tasks.
```
````

A task issue contains its target, task-specific implementation instructions, and validation instructions when needed.

````markdown
```task-config
target: Sources/Feature.swift # optional file, class, feature, or other target
```

```task-prompt
Implement this task.
```

```validation-prompt
Confirm the screen displays the expected content and responds correctly to user actions.
```
````

`epic-triage-prompt`, `epic-validation-prompt`, and `validation-prompt` are optional. Leave them
empty until an individual issue needs them. `skip_triage` defaults to `false`; when it is
`false`, `triage_skill` is required. `validation_skill` is required unless `skip_validation` is
`true`; when validation is skipped, it may be empty.

## Configure Agent Workflows

`.github/octestra/actions/task-agent/action.yml` runs the implementation agent, and
`.github/octestra/actions/validation-agent/action.yml` runs the validation agent. Replace the
placeholder in each file with the configuration and execution steps for your agent.

Octestra installs each agent action once and preserves the whole file on later updates. The
lifecycle workflow is replaced in full; loop workflows and their prompts are consumer-owned and
preserved. Inside an agent action, use its `inputs.*` for context and
`env.OCTESTRA_AGENT_GITHUB_TOKEN` for the agent's GitHub token.

Every rendered agent prompt begins by loading the installed `/octestra-contracts` workflow-contract
skill and names the `task`, `triage`, or `validation` phase. Repository skills own domain policy;
`/octestra-contracts` owns branch, pull request, mutation, and result-file requirements.

Composite actions cannot read the GitHub Actions `secrets` context. Configure cloud credentials
with OIDC, or provide credentials through the selected runner's environment. Run the installer with
`--enable-oidc` when an action needs OIDC.

## Implementation Agent

`lifecycle/prepare-task` runs before the implementation agent. The workflow passes its outputs to
`task-agent/action.yml` as inputs:

| Name | Value |
|---|---|
| `inputs.issue_number` | Task issue number |
| `inputs.prompt` | Rendered implementation prompt |
| `inputs.branch_name` | Exact branch name the agent must push |
| `inputs.draft_flag` | `--draft`, or empty |
| `inputs.skip_validation` | Whether to skip validation |
| `inputs.task_owner` | The person responsible for the task |
| `inputs.epic_id` | EPIC identifier |
| `inputs.parent_number` | EPIC issue number |
| `inputs.task_skill` | Optional task skill specified by the EPIC |
| `inputs.target` | Optional file, class, feature, or other task target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | GitHub token for the agent |

The workflow checks `task_ready` before invoking the composite action. Steps inside the action do
not need to repeat that condition, and they run in the same job, runner, and workspace as
`lifecycle/prepare-task`.

Example configuration for Claude Code Action:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ inputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ inputs.prompt }}
```

The agent must push a branch with exactly the name in `branch_name` and open a pull request from that branch. Otherwise, Octestra moves the task issue to `Blocked`.

## Validation Agent

`lifecycle/prepare-validation` resolves the pull request branch. The workflow checks out that branch
and passes the preparation outputs to `validation-agent/action.yml` as inputs:

| Name | Value |
|---|---|
| `inputs.issue_number` | Task issue number |
| `inputs.prompt` | Rendered validation prompt |
| `inputs.pull_number` | Pull request to validate |
| `inputs.result_path` | Path where the validation result JSON must be written |
| `inputs.artifact_path` | Directory for screenshots, logs, and other evidence |
| `inputs.branch_name` | Checked-out task branch |
| `inputs.parent_number` | EPIC issue number |
| `inputs.validation_skill` | Validation skill specified by the EPIC |
| `inputs.target` | Optional file, class, feature, or other task target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | GitHub token for the agent |

The action runs in the same job, runner, and checked-out workspace as `lifecycle/prepare-validation`.
The validation agent uses the installed `/octestra-contracts` skill to write JSON to
`inputs.result_path` and check its format.

```json
{
  "kind": "validation-result",
  "outcome": "passed",
  "summary": "All checks passed.",
  "checks": [
    {
      "name": "unit tests",
      "result": "passed"
    }
  ],
  "details": "Commands run and anything the reviewer should know."
}
```

`kind`, `outcome`, and `summary` are required. `kind` is always `validation-result`; `outcome` is
`passed` or `failed`. `passed` advances the task to `Human Review`; `failed` moves it to `Blocked`.

### Describe Individual Checks

`checks` is optional. When present, it must be an array of JSON objects. Each object requires non-empty `name` and `result` strings. You can add other custom fields when needed.

Octestra renders one row per check in the validation proof comment. `checks` makes the comment easier to review, but does not independently control the lifecycle: Octestra uses only the top-level `outcome` to advance or block a task.

## Scheduled Agent Loops

`.github/workflows/octestra-loop-todo.yml` is a consumer-owned Todo triage example. It supports
manual runs immediately. To schedule it, choose a cadence and uncomment its `schedule` block. Then
replace the placeholder in
`.github/octestra/actions/triage-agent/action.yml`.

`loop/list-epics` finds open issues carrying the `octestra-epic` label and excludes those whose
`epic-config` sets `skip_triage: true`. The workflow starts one matrix job per remaining EPIC,
with at most three agent jobs running concurrently. `loop/prepare-triage` reads `triage_skill` and the
optional `epic-triage-prompt` block from that EPIC, then renders
`.github/octestra/prompts/loop-todo.md.hbs` with `triageSkill`, `epicTriagePrompt`, and `resultPath`.
Like the lifecycle task and validation preparation operations, it also publishes the skill
separately. The workflow passes `epic_number`, `triage_skill`, `prompt`, and `result_path` to the
local triage action.

Keep task discovery, selection, limits, readiness policy, issue preparation and domain knowledge in
the triage skill rather than in the workflow or prompt. The agent may update issue bodies and other
issue data required by repository policy, but it must not change the `AI Task Status` Issue Field.
After completing every required preparation step, it writes:

```json
{
  "kind": "triage-result",
  "readyIssues": [12, 34],
  "summary": "Optional summary"
}
```

`readyIssues` contains unique positive repository issue numbers for tasks that were fully processed
and are considered ready; an empty array is valid.
`loop/finalize-triage` fails closed on a missing or invalid result. Before any status update it
checks every reported issue is open, a direct sub-issue of the current eligible EPIC, has a valid
task body, and is currently `Todo` or `Ready`. `Ready` is an idempotent no-op. It rechecks each
status immediately before changing `Todo` to `Ready` and never overwrites another status.
Immediately before each actual `Todo` to `Ready` update, it posts an Octestra activity comment on
that task with the source EPIC and workflow-run metadata. Comment posting is best-effort, matching
the lifecycle success path: a comment failure produces a workflow warning but does not prevent the
status update. A task already in `Ready` receives neither an update nor a duplicate activity comment.
If any open, non-opted-out EPIC has no `triage_skill` or has invalid `epic-config`, discovery fails
the run and names that EPIC instead of silently skipping it.

Finalization runs only when the local triage action succeeds.

Loop workflows, prompts, and local actions are preserved on update. If they were installed before
`loop/finalize-triage` existed, migrate the preserved workflow and prompt from the current templates;
the installer reports this condition but does not overwrite repository policy.

## Prompt Templates

Octestra manages agent prompts as Handlebars templates. The implementation template is
`.github/octestra/prompts/lifecycle-in-progress.md.hbs`, the validation template is
`.github/octestra/prompts/lifecycle-validation.md.hbs`, and the Todo triage template is
`.github/octestra/prompts/loop-todo.md.hbs`. The corresponding preparation step renders the template
and passes the result to its local agent action.

Templates can use configuration and prompts from the EPIC and task issue. The main variables are:

- `epicTaskPrompt`: Implementation instructions from the EPIC
- `epicTriagePrompt`: Todo triage instructions from the EPIC
- `taskPrompt`: Implementation instructions from the task issue
- `epicValidationPrompt`: Validation instructions from the EPIC
- `validationPrompt`: Validation instructions from the task issue
- `taskSkill`: Task skill configured by the EPIC
- `triageSkill`: Todo triage skill configured by the EPIC
- `validationSkill`: Validation skill configured by the EPIC
- `target`: Task target, when configured
- `issueNumber`: Task issue number
- `branchName`: Exact task branch during implementation
- `pullNumber`: Associated pull request number, when available
- `draftFlag`: `--draft` when draft pull requests are configured
- `resultPath`: Result path during validation or triage
- `artifactPath`: Artifact directory during validation; available only in the validation workflow

## Change Configuration

`.github/octestra/config.yml` configures the GitHub Actions runners, the GitHub App Octestra uses, task branch naming, and prompt template paths. Use `prompts.loop_todo` to move the Todo triage prompt from its default `.github/octestra/prompts/loop-todo.md.hbs` path. Existing installations without this key continue to use the default path. Set `github_app.private_key_secret_key_name` to the name of the Actions secret holding the GitHub App private key. The secret value is never written to `config.yml`.

After changing `github_app.client_id`, `github_app.private_key_secret_key_name`, a value under `runners`, or `status.field_id`, copy the new values to the repository's Actions variables.

```sh
.github/octestra/octestra.sh vars sync
```
