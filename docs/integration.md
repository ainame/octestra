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
| `In Progress` | `octestra-lifecycle-in-progress.yml` runs the implementation agent. |
| `Validation` | `octestra-lifecycle-validation.yml` runs the validation agent. |
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
validation_skill: ios-ui-validation # required unless validation is skipped
draft_pr: false           # whether to open each task pull request as a draft
skip_validation: false    # when true, move directly to Human Review
```

```epic-task-prompt
Instructions shared by every task in this EPIC.
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

`epic-validation-prompt` and `validation-prompt` are optional. Leave them empty until an individual
issue needs them. `validation_skill` is required unless `skip_validation` is `true`; when
validation is skipped, it may be empty.

## Configure Agent Workflows

`.github/octestra/actions/task-agent/action.yml` runs the implementation agent, and
`.github/octestra/actions/validation-agent/action.yml` runs the validation agent. Replace the
placeholder in each file with the configuration and execution steps for your agent.

Octestra installs each agent action once and preserves the whole file on later updates. Workflows
are replaced in full. Inside an agent action, use its `inputs.*` for lifecycle context and
`env.OCTESTRA_AGENT_GITHUB_TOKEN` for the agent's GitHub token.

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
| `inputs.task_skill_name` | Optional task skill specified by the EPIC |
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
| `inputs.validation_skill_name` | Validation skill specified by the EPIC |
| `inputs.target` | Optional file, class, feature, or other task target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | GitHub token for the agent |

The action runs in the same job, runner, and checked-out workspace as `lifecycle/prepare-validation`.
The validation agent uses the installed `octestra-validation-proof` skill to write JSON to
`inputs.result_path` and check its format.

```json
{
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

Only `outcome` and `summary` are required. To advance to `Human Review`, `outcome` must be exactly `passed`. Any other value moves the task issue to `Blocked`.

### Describe Individual Checks

`checks` is optional. When present, it must be an array of JSON objects. Each object requires non-empty `name` and `result` strings. You can add other custom fields when needed.

Octestra renders one row per check in the validation proof comment. `checks` makes the comment easier to review, but does not independently control the lifecycle: Octestra uses only the top-level `outcome` to advance or block a task.

## Prompt Templates

Octestra manages agent prompts as Handlebars templates. The implementation template is `.github/octestra/prompts/lifecycle-in-progress.md.hbs`, and the validation template is `.github/octestra/prompts/lifecycle-validation.md.hbs`. `Prepare task lifecycle` or `Prepare validation lifecycle` renders the template and passes the result to the agent execution step as `steps.epic.outputs.prompt`.

Templates can use configuration and prompts from the EPIC and task issue. The main variables are:

- `epicTaskPrompt`: Implementation instructions from the EPIC
- `taskPrompt`: Implementation instructions from the task issue
- `epicValidationPrompt`: Validation instructions from the EPIC
- `validationPrompt`: Validation instructions from the task issue
- `taskSkillName`: Task skill name configured by the EPIC
- `validationSkillName`: Validation skill name configured by the EPIC
- `target`: Task target, when configured
- `issueNumber`: Task issue number
- `pullNumber`: Associated pull request number, when available
- `draftFlag`: `--draft` when draft pull requests are configured
- `resultPath`: Result path during validation; available only in the validation workflow
- `artifactPath`: Artifact directory during validation; available only in the validation workflow

## Change Configuration

`.github/octestra/config.yml` configures the GitHub Actions runners, the GitHub App Octestra uses, task branch naming, and prompt template paths. Set `github_app.private_key_secret_key_name` to the name of the Actions secret holding the GitHub App private key. The secret value is never written to `config.yml`.

After changing `github_app.client_id`, `github_app.private_key_secret_key_name`, a value under `runners`, or `status.field_id`, copy the new values to the repository's Actions variables.

```sh
.github/octestra/octestra.sh vars sync
```
