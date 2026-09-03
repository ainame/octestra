# Octestra

**Serverless AI agent orchestration framework built on top of GitHub**

<p align="center">
<img src="docs/assets/octestra-logo.png" alt="Octestra" width="200">
</p>

Octestra is a framework that uses GitHub Issues to run AI agents for task implementation, pull request creation, and validation on GitHub Actions. It manages the progress of task issues with an organization Issue Field and supports the flow through human review and merging.

📖 [日本語](README.ja.md) · [Integration guide](docs/integration.md)

Each node represents the `AI Task Status` of a task issue; each arrow represents an operation that moves it to the next status.

![Octestra task lifecycle](docs/assets/lifecycle.svg)

## Features

Octestra does not include an AI agent. It provides the GitHub workflow around the agent you choose.

- **Task management** — Manage status, ownership, validation, and review through GitHub Issues.
- **GitHub Actions boilerplate** — Provides the workflows and supporting templates for running
  agents on GitHub Actions. Configure agent setup and execution in local actions; define agent
  instructions and repository-specific policy in prompts and skills.
- **Work records** — Record outcomes and evidence in Octestra activity and validation proof
  comments.

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

### How It Works

Octestra has three parts:

1. **Installed files** — Workflows, prompts, and agent setup that you can customize in your
   repository.
2. **Octestra GitHub Action** — Shared task preparation and GitHub updates hosted by this
   repository.
3. **GitHub Project** — A view of task issues and their status. Octestra does not manage the Project
   itself.

### Configure an Agent

The installed agent actions contain placeholders for running agents. Configure implementation,
validation, and triage agents by following the [integration guide](docs/integration.md).

### Run Your First Task

1. Create an EPIC issue and its task issue sub-issues from the installed issue-body contracts.
2. Change the task issue's `AI Task Status` to `Ready`.
3. Change it to `In Progress` to begin implementation.
4. Octestra creates a pull request and moves the task to `Human Review` after validation.

For the EPIC and task issue format, the meaning of each status option, and agent inputs, see the [integration guide](docs/integration.md).

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
