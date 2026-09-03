# Octestra

**Serverless AI agent orchestration framework built on top of GitHub**

<p align="center">
<img src="docs/assets/octestra-logo.png" alt="Octestra" width="200">
</p>

Octestra is a framework that uses GitHub Issues to run AI agents for task implementation, pull request creation, and validation on GitHub Actions. It manages the progress of task issues with an organization Issue Field and supports the flow through human review and merging.

📖 [日本語](README.ja.md) · [Integration guide](docs/integration.md)

Each node represents the `AI Task Status` of a task issue; each arrow represents an operation that moves it to the next status.

![Octestra task lifecycle](docs/assets/lifecycle.svg)

## What Octestra Provides

Octestra does not provide an AI agent. You choose and configure the implementation, triage, and
validation agents that fit your repository. Octestra provides the GitHub-based system around them:

- **An issue-driven task lifecycle:** from implementation and validation through human review and
  merge.
- **GitHub Actions boilerplate:** routing events, preparing agent runs, checking result formats,
  updating task status, and reporting failures. Prompts, skills, and local composite actions are
  clear customization points for how your agents run.
- **A proof-of-work trail:** Octestra activity comments record lifecycle outcomes and workflow
  metadata. Validation proof comments connect agent-reported checks, evidence, and known gaps to
  the pull request and validated commit.
- **Task ownership and human handoffs:** the person who starts a task becomes its issue assignee, is
  added to agent commits as a co-author, and is requested to review the resulting pull request.

## Getting Started

### Requirements

- A repository in a GitHub organization
  - The repository is private and its members are trusted to run coding agents
  - Organization administrator permission to create a custom Issue Field during installation
- [GitHub CLI](https://cli.github.com/) authenticated for the target repository
- A GitHub App installed on the target repository with write access to **Contents**, **Issues**, and **Pull requests**
- A coding agent that can run on GitHub Actions

### Install

Run the installer from the root directory of the repository that will use Octestra.

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

### How Octestra Fits Together

An Octestra setup has three parts:

1. **Files in your repository:** installed workflows, configuration, prompts, skills, and local
   composite actions. Customize agent setup and execution here.
2. **The hosted Octestra GitHub Action:** called by the workflows to prepare work, check agent
   output, and update issues and pull requests.
3. **A GitHub Project:** a table or board for viewing task issues and their status. Octestra does
   not currently create or configure this Project.

### Configure an Agent

The installed agent actions contain placeholders for running agents. Configure an implementation agent and validation agent by following the [integration guide](docs/integration.md).

### Run Your First Task

1. Create an EPIC issue and its task issue sub-issues from the installed issue-body contracts.
2. Change the task issue's `AI Task Status` to `Ready`.
3. Change it to `In Progress` to begin implementation.
4. Octestra creates a pull request and moves the task to `Human Review` after validation.

For the EPIC and task issue format, the meaning of each status option, and agent inputs, see the [integration guide](docs/integration.md).

### Configure the Todo Triage Loop

The installed `.github/workflows/octestra-loop-todo.yml` can run a Todo triage agent manually.
Customize `.github/octestra/prompts/loop-todo.md.hbs` and
`.github/octestra/actions/triage-agent/action.yml`.

Set `triage_skill` and, optionally, the `epic-triage-prompt` block in the EPIC issue. The local
triage action receives the EPIC number, triage skill, rendered prompt, and result path as inputs.
The prompt also exposes the issue configuration as `triageSkill` and `epicTriagePrompt`. Open
`octestra-epic` issues participate by default; set `skip_triage: true` in an EPIC to opt out.
Octestra starts one bounded matrix job per participating EPIC. The repository skill owns task
discovery, selection, limits and readiness policy, including required issue preparation, but must
not change AI Task Status. It reports only fully processed tasks; Octestra validates the result and
moves eligible Todo tasks to Ready.
Scheduled execution is opt-in: choose a cadence and uncomment the workflow's `schedule` block.
Before running it, every open `octestra-epic` issue must either configure `triage_skill` or opt out;
discovery fails loudly rather than silently omitting an invalid EPIC.

## Updating and Maintenance

```sh
.github/octestra/octestra.sh doctor
.github/octestra/octestra.sh vars check
.github/octestra/octestra.sh vars sync
.github/octestra/octestra.sh ref
.github/octestra/octestra.sh update
```

| Command           | Purpose                                                                    |
|-------------------|----------------------------------------------------------------------------|
| `doctor`          | Report problems with configuration, status options, prompts, and workflow  |
| `vars check`      | Check whether the repository's Actions variables match `config.yml`        |
| `vars sync`       | Copy the required values from `config.yml` to Actions variables            |
| `ref`             | Show the Octestra repository and ref used by the installed workflow        |
| `update`          | Install the latest stable release while preserving local policy and `config.yml` |

Rerunning the installer replaces the lifecycle workflow and keeps `config.yml`, all local agent
actions, prompts, and loop workflow. Before installing a newer stable release, update prints its
release notes. Review `git diff` before committing changes from an update. The framework-owned
`/octestra-contracts` skill is replaced, and the obsolete
`/octestra-validation-proof` skill is removed. Existing loop workflow and prompt files are
preserved; installations created before triage finalization must manually adopt the current
`octestra-loop-todo.yml` and `loop-todo.md.hbs` contract.

**v0.3.0 breaking change:** all inputs to `ainame/octestra` use `snake_case`. Because installed loop
workflows are preserved, update their Octestra steps manually (for example, `github-token` becomes
`github_token`, `issue-number` becomes `issue_number`, and `result-path` becomes `result_path`).
The installer replaces the lifecycle workflow with the new names. Kebab-case input aliases are not
supported.

## Security

Octestra currently assumes a **private repository with trusted members**.

- Anyone who can change the `AI Task Status` Issue Field can start an agent.
- Anyone who can edit an issue body can change the agent's instructions.
- The agent receives a GitHub App token with repository write access.
- The agent and the workflow steps with repository write access are not yet isolated into separate jobs.
- A validation result is the validation agent's claim; Octestra does not independently verify it.

Octestra passes only the secrets named in each workflow and never passes every repository or organization secret at once. However, the agent still runs in the same job as steps that can update the repository and its issues. Do not use Octestra for public repositories or untrusted issue input.

## Development

```sh
npm ci
make all
```

`make all` type-checks, runs tests, and rebuilds the committed `dist/index.js` bundle.

Read [`AGENTS.md`](AGENTS.md) before changing Octestra. Architecture decisions are documented in [`docs/design.md`](docs/design.md), and planned work is tracked in [`TODO.md`](TODO.md).

## License

[MIT](LICENSE)
