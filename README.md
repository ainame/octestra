# Octestra

**Serverless AI agent orchestration on GitHub Actions and Projects.**

Move an issue to `In Progress`. An agent implements it, opens a pull request, validation runs, and a
human is asked to review — driven by the task's state, with no server, queue or database to run.

📖 [日本語](README.ja.md) · [Design notes](docs/design.md) · [Glossary](docs/glossary.md)

```
issue #42 ──▶ In Progress ──▶ agent ──▶ pull request ──▶ validation ──▶ review ──▶ Done
```

## Why

### 1. It orchestrates the handoffs, not just the agent run

Running an agent is the easy part. What costs you time is everything after it: turning the work into
a pull request, getting it validated, putting it in front of the right human, and knowing what to do
when any of that fails.

Octestra drives that chain off a task state graph. Implementation hands off to validation, validation
hands off to review, and a merge closes the task — each transition checked against the issue's live
state, so a stale or invalid move routes nothing instead of starting a second agent on the same
branch. Failures land in `Blocked` with a link to the run, not in a log nobody reads.

### 2. It runs entirely on GitHub, so there is no server to deploy

State is a field on the issue. Scheduling is GitHub's own events. Compute is Actions runners you
already have. Nothing to deploy, nothing to keep alive, no second permission model — and
uninstalling is deleting some workflow files.

You could build this out of Actions yourself; none of it is magic. What Octestra gives you is the
inventory already assembled: the transition guard, the seven-state graph, owner assignment, branch
resolution, pull request lookup, review routing, failure recovery. That is the part that takes months
to get right, because each piece fails silently when it is wrong.

### 3. Prompts, configuration and results live in one reviewable place

Agent behaviour is in `.hbs` prompt templates and one `config.yml` — versioned, diffable, and
reviewed in a pull request like anything else, instead of buried in workflow YAML across three files.

Your validation agent's JSON result is rendered into a comment a reviewer actually reads, so "did
this pass, and how do we know?" is answerable on the issue without opening Actions logs. Every
operation Octestra uses is also callable on its own, if you want a workflow of a different shape.

## What it provides, and what it doesn't

| Provides | Does not provide |
|---|---|
| A seven-state task lifecycle on a GitHub issue field | An agent — Octestra never calls a model |
| Owner assignment, branch naming, pull request lookup, review request | A scheduler — something has to move the field |
| Prompts rendered from your own templates | A server, dashboard, queue or database |
| A validation step that posts its result on the issue | Any view across repositories |
| Failure handling: a comment with a run link, task moved to `Blocked` | Acceptance criteria — your validation agent defines `passed` |
| An installer and an updater that keep your customization | Any agent memory — each run starts cold, with the issue and pull request as its context |
| | Isolation between the agent and its token ([Security](#security)) |

## Compared to Symphony

[openai/symphony](https://github.com/openai/symphony) attacks the same problem from the opposite
direction: a service that polls your issue tracker and dispatches agents itself. Neither choice is
free.

| | Octestra | Symphony |
|---|---|---|
| Shape | GitHub Actions workflows | A service you run |
| What starts work | You move the issue field | It polls the tracker and dispatches |
| Issue tracker | GitHub issues | An adapter per tracker |
| The agent | Any step you write | A coding agent speaking Codex app-server |
| Workspace | A fresh runner per run | A per-issue directory on the host, reused |
| Agent context | Re-derived each run from the repo, the issue and the pull request | Accumulated in one live Codex thread, reused across turns |
| Concurrency, retries, backoff | GitHub concurrency groups | Its own scheduler |
| Run length | Actions minutes and job limits | Bounded by your host |
| Credentials live | GitHub Secrets | On the host running it |
| Audit trail | Issue, pull request, Actions logs | Its own logs, plus the tracker |
| Getting started | One installer command | Run the Elixir reference, or build from the spec |

**Choose Symphony** if agents should pick up work unattended, keep iterating inside one accumulated
context instead of starting cold, or run longer than Actions allows — or if your tracker is not
GitHub.

**Choose Octestra** if you would rather not operate a service, your work already lives in GitHub
issues, and you want each run isolated on a fresh runner with its context in the issue and the pull
request rather than in a process.

Both are early, both assume a trusted environment, and neither puts a sandbox around the agent.

## When to use it

Good fit:

- A migration or sweep split into many similar tasks — one EPIC issue, one sub-issue each.
- A backlog of small, well-specified tasks you would rather not shepherd one at a time.
- A team already living in GitHub issues and Projects.

Look elsewhere if:

- You want a single agent run — use [`claude-code-action`](https://github.com/anthropics/claude-code-action) directly.
- You want agents to pick up work with nobody in the loop — see [Symphony](#compared-to-symphony).
- Your repository is not in a GitHub organization.
- Your repository is public, or not everyone who can edit an issue is trusted.

## How it works

One organization Issue Field, `AI Task Status`, holds the state. Changing it starts a workflow run.

```
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
            ▲            │              │                ▲
            │            └──────────────┴────────────────┘  skip_validation: true
            └──────────── Blocked ◀──── any failure above
```

| Status | Set by | Octestra then |
|---|---|---|
| `Todo` | you | — |
| `Ready` | you | — |
| `In Progress` | you | Runs your agent, checks the branch and pull request, moves on |
| `Validation` | Octestra | Runs your validation agent, posts the result, moves on |
| `Human Review` | Octestra | Requests review, then `Done` when the pull request merges |
| `Blocked` | Octestra | Comments why. Move it back to `Ready` to retry |
| `Done` | Octestra | — |

Work is an **EPIC issue** plus one **task issue** per unit of work. The EPIC body holds the config and
instructions its tasks share. An installed agent skill writes both from a plan.

## Requirements

- A repository in a **GitHub organization** — Issue Fields are organization-level.
- [GitHub CLI](https://cli.github.com/), authenticated.
- Organization admin, once, to create the `AI Task Status` field.
- A **GitHub App** with Contents, Issues and Pull requests write access.

## Security

Octestra is built for a **private repository whose members you trust**, and is not safe outside that.

The agent's instructions come from the issue bodies and the repository. In the same job, it holds a
GitHub App token with Contents, Issues and Pull requests write access. So:

- **Whoever can change `AI Task Status` can run an agent.** Treat it as write access.
- Whoever can edit an issue body decides what the agent is told to do.
- The lifecycle steps share the agent's job, so a compromised agent can move the task and comment as
  Octestra.
- `passed` is the validation agent's claim about its own work, not an independent check.

Separating the agent from the privileged token is **not implemented**. What is: no `secrets: inherit`
anywhere, each App token restricted to its own repository, and the private key never read by
Octestra code.

## Install

From the root of the repository that will run the tasks:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

Then install your GitHub App and store its private key as the `OCTESTRA_GITHUB_APP_PRIVATE_KEY`
Actions secret. Rerunning the installer keeps `config.yml` and everything you customized.

| Flag | Effect |
|---|---|
| `--org NAME` | Organization owning the field. Inferred by default. |
| `--status-field NAME` | Field to use or create. Default `AI Task Status`. |
| `--fork` / `--repository OWNER/REPO` | Call your organization's fork instead of `ainame/octestra`. |
| `--ref REF` | Pin to a tag or branch. Default: newest version tag. |
| `--enable-oidc` | Enable `id-token: write` for a cloud role. |
| `--skill-target claude\|codex\|agents` | Where the EPIC setup skill goes. |
| `--yes` | Take the defaults. |

## The contract

Octestra owns the steps that move a task; you own the agent. This is the whole interface.

### You provide

| Where | What |
|---|---|
| `agent-steps` in the in-progress workflow | Setup and invocation of your implementation agent |
| `agent-steps` in the validation workflow | The same, plus any artifact upload |
| `agent-credentials` in both | A `secrets:` entry for each secret those steps need |
| `in-progress-secrets`, `validation-secrets` in `octestra-lifecycle.yml` | Passing those secrets in |
| `.github/octestra/prompts/*.md.hbs` | What each agent is told to do |
| `.github/octestra/config.yml` | Runners, App client ID, branch template, prompt paths |

Each name marks a **custom region** — the lines enclosed by `# octestra:custom:begin <name>` and
`# octestra:custom:end <name>`. Updates keep what is inside and replace everything else.

### Octestra provides

In the in-progress workflow, before your steps:

| Name | Holds |
|---|---|
| `steps.epic.outputs.prompt` | Your task prompt, rendered |
| `steps.epic.outputs.branch_name` | The branch your agent must push. Nothing else is looked for |
| `steps.epic.outputs.task_ready` | `false` when existing work stopped this task. Guard your steps on it |
| `steps.epic.outputs.draft_flag` | `--draft`, or empty |
| `steps.epic.outputs.skip_validation` | Whether the task skips `Validation` |
| `steps.epic.outputs.task_owner` | The issue's assignee |
| `steps.epic.outputs.epic_id`, `parent_number`, `skill_name`, `target_file` | EPIC id and issue number, its skill, the task's target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | The agent's GitHub token |

In the validation workflow, before your steps:

| Name | Holds |
|---|---|
| `steps.epic.outputs.prompt` | Your validation prompt, rendered |
| `steps.epic.outputs.pull_number` | The pull request to validate, already checked out |
| `steps.epic.outputs.result_path` | Where your agent writes its result |
| `steps.epic.outputs.artifact_path` | Where to put screenshots, logs and other evidence |
| `steps.epic.outputs.branch_name`, `parent_number`, `target_file` | Branch, EPIC issue number, target |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | The agent's GitHub token |

With Claude Code Action, pass the branch through unchanged:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

### Don't break these

| Rule | Or else |
|---|---|
| Push exactly `branch_name` | No branch is found; the task is commented on and moved to `Blocked` |
| Open a pull request from it | `PR not found for branch …`, task moved to `Blocked` |
| Write `outcome` and `summary` as JSON to `result_path` | The file cannot be read; task moved to `Blocked` |
| `outcome` is exactly `passed` on success | Anything else moves the task to `Blocked` |
| The validation agent makes no branch or commit | It is on a checked-out pull request head; nothing cleans up a push |
| `Prepare …` stays first, `Finalize …` stays last, both outside the markers | Your steps read `steps.epic.outputs`; the finalize step reports what they did |
| No step id is referenced from inside a custom region | A later version may move it, and GitHub makes the dangling reference an empty string |
| No `secrets: inherit` | It hands every organization secret to a job running an agent |
| `octestra-lifecycle.yml` permissions stay a superset of every workflow it calls | `startup_failure` before any job starts — no logs, nothing to read |

## Configuring a task

The EPIC issue body holds blocks its tasks inherit:

````markdown
```epic-config
id: ios-swift6            # required, lowercase slug — namespaces task branches
skill: swift-concurrency  # optional, an agent skill your prompt can use
draft_pr: false           # open the pull request as a draft
skip_validation: false    # skip Validation, go straight to Human Review
```

```epic-prompt
Instructions every task in this EPIC receives.
```

```validation-prompt
Instructions the validation agent receives.
```
````

A task issue adds `task-config` (an optional `target`) and `task-prompt`. Both prompts are appended to
the EPIC's.

> Set `skip_validation: true` until your validation workflow has a real agent — the shipped
> placeholder fails on purpose.

`config.yml` holds the runners, App client ID, branch template
(`octestra/{epic_id}/issue-{issue_number}`) and prompt paths. Four values are also copied into
repository variables, because a workflow needs them before it can read a file. Edit the file, then
run `octestra.sh vars sync`.

## The validation result file

Your validation agent writes JSON to `result_path`. Only `outcome` and `summary` are required.
Octestra renders it as an issue comment and reads `outcome` to route the task.

```json
{
  "outcome": "passed",
  "summary": "All checks passed.",
  "checks": [
    { "name": "unit tests", "kind": "test", "result": "passed", "evidence": "3 packages" }
  ],
  "details": "Markdown with commands run and anything a reviewer should know."
}
```

`acceptance`, `checks`, `evidence`, `artifacts`, `knownGaps` and `details` are optional. Unknown
fields are ignored, so extend it freely.

## Maintaining an installation

```sh
.github/octestra/octestra.sh doctor          # report every problem, non-zero if any
.github/octestra/octestra.sh vars check      # non-zero if a variable no longer matches config.yml
.github/octestra/octestra.sh vars sync       # write config.yml values into the variables
.github/octestra/octestra.sh ref             # show which Octestra the workflows call
.github/octestra/octestra.sh update --latest # reinstall from the newest version tag
```

`doctor` only reads, and catches what otherwise fails silently: a stale or unset variable, a renamed
field, a missing status option, an enabled job with no workflow file, a prompt path pointing nowhere,
a marker without its pair.

`update` downloads the target version and runs **its** installer, so an update always runs the new
logic. Review with `git diff` before committing.

## Operations

Each step runs one operation, named by its `operation:` input. An **aggregate** does several things
behind one name; the generated workflows use those. An **individual** operation is one piece, for a
repository that needs a different order.

| Type | Operation | Behavior |
|---|---|---|
| Guard | `lifecycle/validate-transition` | Checks a status change against the live issue. An invalid change by a person is assigned to them and explained. |
| Aggregate | `lifecycle/prepare-task` | Assigns the owner, stops if a branch or pull request exists, renders the prompt, sets the co-author trailer. |
| Aggregate | `lifecycle/finalize-task` | Resolves branch and pull request, requests review if a human is next, updates status, comments. |
| Aggregate | `lifecycle/prepare-validation` | Resolves the pull request, renders the prompt, publishes the result and artifact paths. |
| Aggregate | `lifecycle/finalize-validation` | Posts the result; `passed` requests review and moves to `Human Review`, anything else to `Blocked`. |
| Aggregate | `lifecycle/finalize-merged-task` | Moves a `Human Review` task to `Done` when its pull request merges. |
| Aggregate | `lifecycle/report-failure` | Comments with a run link and moves the task to `Blocked`. |
| Individual | `assign-owner` | Assigns whoever made the change, keeping the owner for bot transitions. |
| Individual | `lifecycle/build-task-context` | `prepare-task` without the owner assignment. |
| Individual | `lifecycle/build-validation-context` | The context half of `prepare-validation`. |
| Individual | `resolve-task-pr` | Publishes the open pull request number for a branch. |
| Individual | `report-proof` | Renders a result file as an issue comment, without touching status. |
| Individual | `request-review` | Marks the pull request ready and requests review. |
| Individual | `update-status` | Sets the field to a status. |

## Development

```sh
npm ci
make all
```

`make all` must be green before any commit. It regenerates `dist/index.js`, which is committed
because it is the Actions runtime bundle.

[`AGENTS.md`](AGENTS.md) is the contract for changing this repository.
[`docs/design.md`](docs/design.md) records why it is shaped this way,
[`docs/glossary.md`](docs/glossary.md) fixes the vocabulary, [`TODO.md`](TODO.md) tracks open work.

## License

[MIT](LICENSE)
