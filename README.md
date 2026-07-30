# Octestra

**A serverless AI agent orchestration framework, built on GitHub Actions and Projects.**

Run many coding agents across many tasks without deploying anything. Task state is a field on a
GitHub issue. Scheduling is GitHub's own event system. Compute is the Actions runners you already
have. There is no coordinator to keep alive, no queue, no database, and nothing to page you at 3am.

📖 [日本語版 README](README.ja.md) · [Design notes](docs/design.md) · [Glossary](docs/glossary.md)

```
you: move issue #42 to `In Progress`
                │
                ▼
     agent implements → pull request → validation → review requested → merged → Done
```

## Why Octestra

### 1. There is no server, because there is nothing to run

Every other way to orchestrate agents needs something alive: a coordinator process, a work queue, a
database holding which task is in which state. Each is a thing to deploy, monitor, secure, and pay
for — infrastructure standing between you and the work.

Octestra has none of it. The state machine is an organization Issue Field, so GitHub stores your task
state and GitHub's event system is your scheduler. Your Project board is the dashboard, already
built. Uninstalling is deleting some workflow files: there is no service left running, no data to
migrate, and no second permission model — access is the GitHub permissions you already manage.

### 2. Any agent, and no lock-in to ours

Octestra never calls a model. It owns the tedious, easy-to-get-wrong half — who owns the task, which
branch the work lives on, finding the pull request, asking the right human for review, recovering
when a run fails — and hands your agent nothing but a rendered prompt and the branch to push.

That boundary is the product. Swapping Claude Code for Codex, or for a shell script, is editing one
block in one file. Your choice of agent is never a migration.

### 3. Reviewable by default, so you can actually ship the output

Agent output that nobody can review is a liability. Here, every task produces a branch, a pull
request, a named reviewer, and a comment on the issue saying what happened. Nothing merges without a
human moving it to `Done`. Failures land in `Blocked` with a link to the run instead of disappearing.

### 4. Customize it without forfeiting updates

Generated CI normally rots the day you edit it — the next update overwrites the wiring you added, so
in practice nobody ever updates. Octestra marks the parts you own, and `octestra.sh update` carries
them into the new version while replacing everything around them. Taking a newer Octestra stays one
command, permanently.

## Serverless, concretely

| | Octestra | A server-based orchestrator |
|---|---|---|
| Task state lives in | A field on the issue | A database you operate |
| Scheduling | GitHub issue events | A coordinator process you keep alive |
| Compute | Actions runners you already have | Workers you provision |
| Dashboard | Your GitHub Project board | Its own UI, beside your repo |
| Audit trail | The issue, the pull request, Actions logs | Its own store, to be exported |
| Access control | GitHub permissions | A second permission model to keep in sync |
| To remove it | Delete the workflow files | Decommission a service |

What you give up by having no server:

- **No unattended start.** Something has to move the field — a person, or a scheduled workflow you
  add. Octestra ships no scheduler of its own.
- **One repository at a time.** There is no cross-repository view, because there is nothing central
  to hold one.
- **Actions minutes.** Long agent runs are billed as Actions time, on runners you choose per job.
- **GitHub only.** The design is inseparable from Issue Fields and `workflow_call`.

## When to use it

Good fits:

- A migration or a sweep split into many similar units of work — one EPIC issue, one sub-issue each.
- A backlog of small, well-specified tasks you would rather not shepherd one at a time.
- A team already living in GitHub issues and Projects that does not want a second place to look.

Look elsewhere if:

- You want a single agent run — use [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) directly.
- Your repository is not in a GitHub organization. Octestra is driven by an organization Issue Field,
  a custom field GitHub lets an organization add to its issues.
- Your repository is public, or not everyone who can edit an issue is trusted. See [Security](#security).

## How it works

Everything is driven by one field on the issue — `AI Task Status`, an Issue Field your organization
owns. Its seven options are the task states, and changing the field is what starts a workflow run:

```
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
            ▲            │              │                ▲
            │            └──────────────┴────────────────┘  skip_validation: true
            └──────────── Blocked ◀──── any failure above
```

| Status | Who sets it | What Octestra does |
|---|---|---|
| `Todo` | you | Nothing. The task is not ready to start. |
| `Ready` | you | Nothing. Waiting for you to release it. |
| `In Progress` | you | Runs your implementation agent, confirms the branch and pull request, then moves to `Validation` or `Human Review`. |
| `Validation` | Octestra | Runs your validation agent, posts its result on the issue, then moves to `Human Review` or `Blocked`. |
| `Human Review` | Octestra | Marks the pull request ready, requests review from the task owner, and moves to `Done` when that pull request merges. |
| `Blocked` | Octestra | Nothing. Comments why, and waits for you to move it back to `Ready`. |
| `Done` | Octestra | Nothing. The task is finished. |

Work is organised as an **EPIC issue** with one **task issue** per unit of work. The EPIC's body
carries the configuration and instructions its tasks share; each task issue carries its own. The
installer adds a skill for Claude Code, Codex or another agent that writes both from a plan, so you
do not open fifty issues by hand.

## Requirements

- A repository in a **GitHub organization** — Octestra routes on organization Issue Fields.
- [GitHub CLI](https://cli.github.com/), authenticated.
- Organization administrator access, once, to create the `AI Task Status` field. An existing
  compatible field can be reused instead.
- A **GitHub App** with repository **Contents**, **Issues** and **Pull requests** write access.
- A GitHub Project, if you want a board over the EPIC and its tasks.

## Security

Read this before installing. Octestra is built for a **private repository whose members you trust**,
and it is not safe outside that.

An agent runs with instructions taken from the task issue body, from its parent EPIC issue body, and
from the repository contents. In that same job, Octestra gives it a GitHub App token with Contents,
Issues and Pull requests write access, and the checkout leaves that token on disk. So, today:

- **Anyone who can change the `AI Task Status` field can start an agent run.** Treat that ability as
  equivalent to write access to the repository.
- Anyone who can edit an issue body decides what that agent is told to do.
- The steps that move the task run in the same job as the agent, so an agent that goes wrong can also
  change the task's status and comment as Octestra.
- A validation agent judges the pull request it was given and writes its own result file. A `passed`
  outcome is that agent's claim, not an independent check of it.

Separating agent execution from the privileged token is not implemented. What is in place:
`secrets: inherit` is used nowhere, so an agent job receives only the secrets its own workflow
declares and the caller passes; each App token is restricted to the single repository it runs in; and
the App private key stays in GitHub Actions Secrets, where no Octestra code reads it.

Before installing, decide who may change the status field — that is who may run an agent — and what
the agent's credentials reach beyond this repository. A cloud role assumed through OIDC, or a model
API key, is as exposed as the agent is.

## Install

Run from the root of the repository that will run the tasks:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

It finds or creates the `AI Task Status` field, writes the workflows, prompts, the
`.github/octestra/octestra.sh` maintenance tool and the EPIC setup skill, and syncs four repository
variables. Rerunning it is safe: `config.yml` is kept, and so is everything you wrote between the
you customized in the places [The contract](#the-contract) marks out.

Then install your GitHub App with Contents, Issues and Pull requests write access, and store its
private key as the `OCTESTRA_GITHUB_APP_PRIVATE_KEY` Actions secret. Each workflow mints a token
scoped to its own repository, so the App needs no configuration beyond that.

| Flag | Effect |
|---|---|
| `--org NAME` | Organization owning the Issue Field. Inferred from the repository by default. |
| `--status-field NAME` | Field name to use or create. Defaults to `AI Task Status`. |
| `--fork` / `--repository OWNER/REPO` | Call your organization's fork instead of `ainame/octestra`. |
| `--ref REF` | Pin the workflows to a tag or branch. Defaults to the newest version tag. |
| `--enable-oidc` | Enable `id-token: write`, for a cloud role assumed through OIDC. |
| `--skill-target claude\|codex\|agents` | Which directory the EPIC setup skill is installed into. |
| `--yes` | Accept the defaults without prompting. |

The generated workflows call Octestra as an action, so their `uses:` reference decides whose code
runs in your repository. Pointing them at your own fork means you run only code your organization
controls, in exchange for merging upstream yourself; `octestra.sh ref` changes that choice later. A
private fork also has to allow the repositories that call it, under its Actions access policy.

## The contract

Octestra owns the steps that move a task; you own the agent. This is the whole interface between the
two — read it once before writing your agent steps.

### What you provide

| Where | What |
|---|---|
| `agent-steps` in `octestra-lifecycle-in-progress.yml` | The steps that set up and run your implementation agent. |
| `agent-steps` in `octestra-lifecycle-validation.yml` | The same for your validation agent, plus any artifact upload. |
| `agent-credentials` in both files | An `on.workflow_call.secrets` entry for every secret those steps need. |
| `in-progress-secrets`, `validation-secrets` in `octestra-lifecycle.yml` | Passing each of those secrets in from the caller. |
| `.github/octestra/prompts/*.md.hbs` | What each agent is told to do. |
| `.github/octestra/config.yml` | The two runners, the App client ID, the branch template, the prompt paths. |

Each of those names marks a **custom region**: the lines enclosed by a matching pair of
`# octestra:custom:begin <name>` and `# octestra:custom:end <name>` markers. An update keeps what is
inside them and replaces everything else, so anything you write outside one is lost. If a region
cannot be carried over, the installer saves the previous file as `<workflow>.yml.octestra-bak` and
says so.

### What Octestra gives you

In `octestra-lifecycle-in-progress.yml`, before your steps run:

| Name | Holds |
|---|---|
| `steps.epic.outputs.prompt` | Your task prompt, rendered. |
| `steps.epic.outputs.branch_name` | The branch your agent must push. Nothing else is looked for later. |
| `steps.epic.outputs.task_ready` | `false` when an existing branch or open pull request stopped this task. Guard your steps on it. |
| `steps.epic.outputs.draft_flag` | `--draft` when the pull request should be a draft, empty when not. |
| `steps.epic.outputs.skip_validation` | Whether this task goes straight to `Human Review`. |
| `steps.epic.outputs.task_owner` | The human assigned to the issue. |
| `steps.epic.outputs.epic_id`, `parent_number`, `skill_name`, `target_file` | The EPIC's id, its issue number, the skill it names, and the task's target. |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | The agent's GitHub token. |

In `octestra-lifecycle-validation.yml`, before your steps run:

| Name | Holds |
|---|---|
| `steps.epic.outputs.prompt` | Your validation prompt, rendered. |
| `steps.epic.outputs.pull_number` | The open pull request to validate. It is already checked out. |
| `steps.epic.outputs.result_path` | The file your agent must write its result to. |
| `steps.epic.outputs.artifact_path` | The directory for screenshots, logs and other evidence. |
| `steps.epic.outputs.branch_name`, `parent_number`, `target_file` | The task branch, the EPIC's issue number, and the task's target. |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | The agent's GitHub token. |

Using Claude Code Action, pass the branch through unchanged:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

### What you must not break

| Rule | What happens if you do |
|---|---|
| Your agent pushes exactly `branch_name` | Octestra finds no branch, comments that the agent created none, and moves the task to `Blocked`. |
| Your agent opens a pull request from that branch | The finalize step fails with `PR not found for branch …`, and the task moves to `Blocked`. |
| Your validation agent writes `outcome` and `summary` as JSON to `result_path` | The finalize step fails on the unreadable file, and the task moves to `Blocked`. |
| `outcome` is exactly `passed` for a success | Any other value moves the task to `Blocked` — right for a real failure, a silent surprise for a typo. |
| Your validation agent creates no branch and no commit | It is validating a checked-out pull request head; a push from here is part of no lifecycle and nothing cleans it up. |
| The `Prepare …` and `Finalize …` steps stay outside the markers, first and last | Your steps read `steps.epic.outputs`, so nothing works before the prepare step; the finalize step reports what your steps did, so it must be last. |
| Nothing inside a custom region names another step by its id | A later version can move that step, and GitHub turns the dangling reference into an empty string instead of an error. |
| No `secrets: inherit`, anywhere | It hands every organization secret to a job that runs an agent. |
| `octestra-lifecycle.yml`'s workflow-level `permissions:` stays a superset of every workflow it calls | The whole run fails with `startup_failure` before any job starts — no logs, no annotation, nothing to read. |

## Configuring a task

An EPIC issue body carries fenced blocks its tasks inherit; a task issue body carries its own.

````markdown
```epic-config
id: ios-swift6            # required, lowercase slug — namespaces the task branches
skill: swift-concurrency  # optional, an agent skill to select
draft_pr: false           # open the pull request as a draft
skip_validation: false    # go straight to Human Review, without a validation run
```

```epic-prompt
Instructions every task in this EPIC receives.
```

```validation-prompt
Instructions the validation agent receives.
```
````

A task issue takes `task-config` with an optional `target`, and `task-prompt` with instructions for
that task alone. Both prompts are appended to the EPIC's.

> Set `skip_validation: true` until your validation workflow has a real agent in it. The shipped
> placeholder fails on purpose, which sends the task to `Blocked`.

`.github/octestra/config.yml` holds the rest: the two runner labels, the App client ID, the branch
template (`octestra/{epic_id}/issue-{issue_number}` by default), and the prompt paths. Four of its
values are also copied into repository variables, because a workflow needs them before it can read a
file: `OCTESTRA_GITHUB_APP_CLIENT_ID`, `OCTESTRA_ORCHESTRATION_RUNNER`, `OCTESTRA_AGENT_RUNNER` and
`OCTESTRA_STATUS_FIELD_ID`. Edit the file, then run `octestra.sh vars sync`.

## The validation result file

Your validation agent writes JSON to `result_path` — Octestra calls this file the **proof**. Only
`outcome` and `summary` are required. Octestra renders it as an issue comment for the reviewer, and
reads `outcome` to decide where the task goes.

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

`acceptance`, `checks`, `evidence`, `artifacts`, `knownGaps` and `details` are optional and rendered
when present. Unknown fields are ignored, so you can extend the document freely. Octestra does not
check the contents against your acceptance criteria — those stay yours.

## Maintaining an installation

`.github/octestra/octestra.sh` is installed beside `config.yml` and needs only an authenticated
GitHub CLI.

```sh
.github/octestra/octestra.sh doctor          # report every problem, exit non-zero if any
.github/octestra/octestra.sh vars check      # exit non-zero if a variable no longer matches config.yml
.github/octestra/octestra.sh vars sync       # write the config.yml values into the variables
.github/octestra/octestra.sh ref             # show which Octestra the workflows call
.github/octestra/octestra.sh update --latest # reinstall from the newest version tag
```

`doctor` only reads. It catches the failures that are otherwise silent: a variable that no longer
matches `config.yml` or was never set, a renamed field, a missing status option, an enabled job whose
workflow file is absent, a prompt path that points nowhere, and a marker left without its pair.

`update` downloads the target version and runs **its** installer against your repository, so an
update always runs the new logic. It reuses the answers your installation already records, and
re-syncs the variables at the end. Review the result with `git diff` before committing.

## Operations

Each step above runs one Octestra operation, named by its `operation:` input. An **aggregate** does
several things behind one name, and the generated workflows use those. An **individual** operation is
one of those things on its own, for a repository that needs a different order.

| Type | Operation | Behavior |
|---|---|---|
| Guard | `lifecycle/validate-transition` | Validates a status change against the live issue state. An invalid change by a person is assigned to them and explained, without moving the task. |
| Aggregate | `lifecycle/prepare-task` | Assigns the task owner, stops if a branch or pull request already exists, renders the task prompt, and sets up the Git co-author trailer. |
| Aggregate | `lifecycle/finalize-task` | Resolves the branch and pull request, requests review when a human is next, updates the status, and comments with the result. |
| Aggregate | `lifecycle/prepare-validation` | Resolves the pull request, renders the validation prompt, and publishes the result and artifact paths. |
| Aggregate | `lifecycle/finalize-validation` | Posts the proof, and on `passed` requests review and moves to `Human Review`; anything else moves to `Blocked`. |
| Aggregate | `lifecycle/finalize-merged-task` | Moves a `Human Review` task to `Done` when its pull request merges. |
| Aggregate | `lifecycle/report-failure` | Comments with a link to the failed run and moves the task to `Blocked`. |
| Individual | `assign-owner` | Assigns whoever triggered the change, keeping the existing owner for bot transitions. |
| Individual | `lifecycle/build-task-context` | The context half of `prepare-task`, without the owner assignment. |
| Individual | `lifecycle/build-validation-context` | The context half of `prepare-validation`. |
| Individual | `resolve-task-pr` | Publishes the open pull request number for a branch. |
| Individual | `report-proof` | Renders a proof file as an issue comment, without touching the status. |
| Individual | `request-review` | Marks the pull request ready and requests review from the task owner. |
| Individual | `update-status` | Sets the Issue Field to a status. |

## Development

```sh
npm ci
make all
```

`make all` must be green before any commit, and it regenerates `dist/index.js`, which is committed
because it is the Actions runtime bundle.

[`AGENTS.md`](AGENTS.md) is the contract for changing this repository: layout, platform invariants,
code style and the review checklist. [`docs/design.md`](docs/design.md) records why the system is
shaped the way it is, [`docs/glossary.md`](docs/glossary.md) fixes the vocabulary, and
[`TODO.md`](TODO.md) tracks open work.

## License

[MIT](LICENSE)
