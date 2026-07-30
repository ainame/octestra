# Octestra

**A serverless AI agent orchestration framework for GitHub Actions and Projects.**

<p align="center">
<img src="docs/assets/octestra-logo.png" alt="Octestra" width="200">
</p>

Move an issue to `In Progress`. Octestra takes it from there: your coding agent implements the task,
opens a pull request, validation checks the change, and a person reviews the result.

The whole workflow runs on GitHub. There is no orchestration server, queue, or database to operate.

📖 [日本語](README.ja.md) · [Design notes](docs/design.md) · [Glossary](docs/glossary.md)

```text
GitHub issue
    │
    ▼
In Progress ──▶ your agent ──▶ pull request ──▶ validation ──▶ human review ──▶ Done
```

## Overview

Octestra connects GitHub Issues, GitHub Actions, and the coding agent you choose. A custom field on
each issue records where the task is in the workflow. Changing that field starts the next step, and
every result stays visible in the issue, pull request, or Actions run.

Octestra does not select work from your backlog. A person or another automation starts a task by
setting its `AI Task Status` field to `In Progress`.

## Features

- **Runs on GitHub.** A custom field on each issue records its current step, and GitHub Actions runs
  the work.
- **Works with your agent.** Add any action or command that can implement a task and open a pull
  request.
- **Handles every handoff.** Octestra finds the agent's branch and pull request, starts validation,
  requests review, updates the issue, and reports failures.
- **Keeps instructions in the repository.** Prompts and settings are versioned alongside the code.
- **Preserves your setup.** Updating Octestra keeps the workflow sections where you configured the
  agent and its credentials.

## Why Octestra

### Orchestrate delivery, not just an agent run

Running a coding agent is one step. Shipping its work also means finding the branch and pull
request, validating the change, routing it to a reviewer, and recovering when something fails.
Octestra connects those handoffs into one visible workflow.

Each handoff checks the issue's current status before it runs. A failure moves the task to
`Blocked` and adds a link to the failed Actions run, instead of leaving the task stalled in a log.

### Stay serverless

The issue stores the task status, GitHub events start the work, and GitHub Actions provides the
compute. Octestra adds orchestration without adding another service to deploy, monitor, secure, or
back up.

### Bring your own agent

Octestra does not call a model or require one agent vendor. Your workflow can run any GitHub Action
or command that implements the task and opens a pull request. Prompts, runner choices, and agent
credentials remain in your repository and go through normal code review.

## Getting Started

### Requirements

- A repository in a GitHub organization
- [GitHub CLI](https://cli.github.com/) authenticated for that repository
- Organization admin access to create the custom issue field during installation
- A GitHub App installed on the repository with **Contents**, **Issues**, and **Pull requests** write
  access
- A coding agent that can run in GitHub Actions

Run the installer from the repository that will use Octestra:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

Then:

1. Save the GitHub App private key as the `OCTESTRA_GITHUB_APP_PRIVATE_KEY` Actions secret.
2. Replace the placeholder agent step in
   `.github/workflows/octestra-lifecycle-in-progress.yml`.
3. Configure `.github/workflows/octestra-lifecycle-validation.yml`, or disable validation while
   setting up your first group of tasks.
4. Ask your coding agent to use the installed `setup-migration-epic` skill. The skill turns your
   plan into one parent issue and a sub-issue for each task.
5. Set a task issue's `AI Task Status` field to `In Progress`.

The installer adds GitHub Actions workflows, prompt templates, one configuration file, a maintenance
script, the `setup-migration-epic` agent skill, and the seven values used by the status field.

> [!WARNING]
> Octestra currently targets private repositories whose members are trusted. See
> [Security](#security) before using it.

## How It Works

Octestra creates an organization-level GitHub Issue Field named `AI Task Status`. An Issue Field is
a custom field attached directly to an issue. Changing its value moves the task through this flow:

```text
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
             ▲            │              │                ▲
             │            └──────────────┴────────────────┘  validation disabled
             └──────────── Blocked ◀──── any failure above
```

| Status | What happens |
|---|---|
| `Todo` | The task exists but is not ready to run. |
| `Ready` | The task is ready for a person or another GitHub workflow to start. |
| `In Progress` | The implementation agent runs and opens a pull request. |
| `Validation` | The validation agent evaluates the pull request and posts its result. |
| `Human Review` | Octestra requests review from the person assigned to the task issue. |
| `Blocked` | Octestra comments with the failure and Actions run link. Move the task to `Ready` to retry. |
| `Done` | The task is complete. |

Tasks are organized under an **EPIC issue** — the parent issue whose `epic-config` block configures
every task issue under it. Each **task issue** is one unit of agent work and a sub-issue of that
EPIC.

## Agent Integration

Octestra handles the steps before and after an agent run. You configure the commands that run the
agent.

The installed workflows contain **custom regions** — the lines enclosed by a matching pair of
`# octestra:custom:begin <name>` and `# octestra:custom:end <name>` markers. Put your agent setup
inside these regions. An update carries their contents into the new workflow and replaces
everything outside them.

| Custom region | Add |
|---|---|
| `agent-steps` | Environment setup, dependencies, agent invocation, and optional artifact upload |
| `agent-credentials` | Names and descriptions of the secrets required by those steps |
| `in-progress-secrets` | Values passed from the main workflow to the implementation workflow |
| `validation-secrets` | Values passed from the main workflow to the validation workflow |

### Implementation agent inputs

Before the implementation agent runs, Octestra's `lifecycle/prepare-task` action prepares these
values for your workflow steps:

| Name | Value |
|---|---|
| `steps.epic.outputs.prompt` | Rendered implementation prompt |
| `steps.epic.outputs.branch_name` | Exact branch the agent must push |
| `steps.epic.outputs.task_ready` | `false` when existing work prevents another run |
| `steps.epic.outputs.draft_flag` | `--draft`, or empty |
| `steps.epic.outputs.skip_validation` | Whether validation is skipped |
| `steps.epic.outputs.task_owner` | Human responsible for the task |
| `steps.epic.outputs.epic_id` | EPIC identifier |
| `steps.epic.outputs.parent_number` | EPIC issue number |
| `steps.epic.outputs.skill_name` | Optional skill named by the EPIC |
| `steps.epic.outputs.target_file` | Optional task target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | GitHub token for the agent |

Example with Claude Code Action:

```yaml
- uses: anthropics/claude-code-action@v1
  if: steps.epic.outputs.task_ready == 'true'
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

The agent must push `branch_name` exactly and open a pull request from it. Otherwise Octestra moves
the task to `Blocked`.

### Validation agent inputs

Before the validation agent runs, Octestra's `lifecycle/prepare-validation` action checks out the
pull request's branch and prepares these values:

| Name | Value |
|---|---|
| `steps.epic.outputs.prompt` | Rendered validation prompt |
| `steps.epic.outputs.pull_number` | Pull request being validated |
| `steps.epic.outputs.result_path` | Path for the validation result JSON |
| `steps.epic.outputs.artifact_path` | Directory for screenshots, logs, and other evidence |
| `steps.epic.outputs.branch_name` | Checked-out task branch |
| `steps.epic.outputs.parent_number` | EPIC issue number |
| `steps.epic.outputs.target_file` | Optional task target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | GitHub token for the agent |

The validation agent writes JSON to `result_path`:

```json
{
  "outcome": "passed",
  "summary": "All checks passed.",
  "checks": [
    {
      "name": "unit tests",
      "kind": "test",
      "result": "passed",
      "evidence": "3 packages"
    }
  ],
  "details": "Commands run and anything the reviewer should know."
}
```

Only `outcome` and `summary` are required. `outcome` must be exactly `passed` to advance to
`Human Review`; any other value moves the task to `Blocked`.

Inside a custom region, use only the Octestra values listed above and the `secrets`, repository
variables, or workflow inputs declared in the same workflow file. Do not read a value directly from
another workflow step. An update may replace that step, leaving your agent with an empty value.

## Task Configuration

An EPIC issue is the parent for a related group of tasks. Its body contains:

````markdown
```epic-config
id: ios-swift6            # lowercase name used in task branch names
skill: swift-concurrency  # optional skill for the implementation agent
draft_pr: false           # open each task pull request as a draft
skip_validation: false    # send tasks directly to Human Review when true
```

```epic-prompt
Instructions shared by every task in this EPIC.
```

```validation-prompt
Instructions for the validation agent.
```
````

Each task sub-issue adds an optional file or component to change and its own instructions:

````markdown
```task-config
target: Sources/Feature.swift # optional file or component to change
```

```task-prompt
Implement this task.
```
````

`.github/octestra/config.yml` controls which GitHub Actions runners execute the workflows, which
GitHub App Octestra uses, how task branches are named, and where prompt templates live.

After changing `github_app.client_id`, a value under `runners`, or `status.field_id`, copy the new
values to the repository's Actions variables:

```sh
.github/octestra/octestra.sh vars sync
```

## Installation Options

| Flag | Effect |
|---|---|
| `--org NAME` | Organization that owns the custom issue field; inferred by default |
| `--status-field NAME` | Custom issue field to use or create; default: `AI Task Status` |
| `--github-app-client-id ID` | GitHub App client ID |
| `--skill-target claude\|codex\|agents` | Directory for the EPIC setup skill |
| `--repository OWNER/REPO` | Octestra repository used by installed workflows |
| `--fork` | Short for `--repository ORGANIZATION/octestra` |
| `--ref REF` | Version tag or branch; upstream defaults to the newest version tag |
| `--enable-oidc` | Let workflow steps authenticate to a cloud provider through GitHub OIDC |
| `--yes` | Accept defaults without prompting |

Rerunning the installer keeps `config.yml` and the contents of every custom region.

## Updating and Maintenance

```sh
.github/octestra/octestra.sh doctor
.github/octestra/octestra.sh vars check
.github/octestra/octestra.sh vars sync
.github/octestra/octestra.sh ref
.github/octestra/octestra.sh update --latest
```

| Command | Purpose |
|---|---|
| `doctor` | Report problems with configuration, the status field, prompts, and workflows |
| `vars check` | Check whether the repository's Actions variables match `config.yml` |
| `vars sync` | Copy the required values from `config.yml` to Actions variables |
| `ref` | Show the Octestra repository and ref used by installed workflows |
| `update --latest` | Install the newest release while preserving custom regions |

Review `git diff` after an update before committing it.

## Security

Octestra currently assumes a **private repository with trusted members**.

- Anyone who can change the `AI Task Status` field can start an agent.
- Anyone who can edit an issue body can change the agent's instructions.
- The agent receives a GitHub App token with repository write access.
- The agents and the workflow steps with repository write access are not yet isolated into separate
  jobs.
- A validation result is the validation agent's claim; Octestra does not independently verify it.

Octestra passes only the secrets named in each workflow and never passes every repository or
organization secret at once. However, the agent still runs in the same job as steps that can update
the repository and its issues. Do not use Octestra for public repositories or untrusted issue input.

## Advanced Usage

Each Octestra step selects one operation through the `operation:` input in
[`action.yml`](action.yml). The installed workflows use the operations that perform complete
implementation and validation handoffs. You can call the smaller operations directly when you need
a different workflow order.

## Comparison with OpenAI Symphony

[OpenAI Symphony](https://github.com/openai/symphony) is a specification with an experimental
reference service. The service repeatedly checks a project tracker for eligible issues, gives each
issue its own reusable working directory, and runs Codex until the issue no longer needs work.

Octestra focuses on explicit handoffs inside GitHub. A field change starts a GitHub Actions
workflow, and that workflow calls whichever implementation or validation agent you configured.

| | Octestra | Symphony |
|---|---|---|
| Primary role | Move one task through implementation, validation, and review | Select eligible tasks and keep agents working on them |
| Runtime | GitHub Actions workflows | Long-running service or executable |
| Trigger | A change to the task's `AI Task Status` field | The service repeatedly checks the tracker |
| Trackers | GitHub Issues | Linear, GitHub Issues, Jira Cloud, Asana, and GitLab in the reference implementation |
| Agent | Any action or command you configure | Codex through its app-server interface |
| Working directory | A fresh GitHub Actions job for each workflow run | A directory for each issue, reused across runs |
| Agent session | One agent run for implementation and another for validation | Multiple Codex turns while the service handles an issue |
| Parallel work and retries | Managed by GitHub Actions | Managed by Symphony |
| Human review | A built-in `Human Review` step | Defined by your tracker states and Symphony's `WORKFLOW.md` file |
| Infrastructure | No Octestra process stays running | Requires a running process, local disk, and tracker credentials |

**Choose Octestra** for GitHub-native, event-driven handoffs with your own agent.

**Choose Symphony** when agents should select work without a person starting each task, when Codex
needs a working directory that survives across runs, or when your tracker is not GitHub.

For a single agent run without these handoffs, call the agent's GitHub Action directly.

## Development

```sh
npm ci
make all
```

`make all` type-checks, tests, and rebuilds the committed `dist/index.js` bundle.

Read [`AGENTS.md`](AGENTS.md) before changing Octestra. Architecture decisions are documented in
[`docs/design.md`](docs/design.md), and planned work is tracked in [`TODO.md`](TODO.md).

## License

[MIT](LICENSE)
