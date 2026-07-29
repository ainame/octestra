# Octestra

Octestra is a system for managing and executing AI coding tasks through GitHub.
It combines three components:

1. **GitHub Project task structure**
   Large initiatives are represented by an EPIC issue with task-specific sub-issues.
2. **Generic lifecycle workflows**
   `octestra-lifecycle.yml` receives Issue Field events, validates each transition, and dispatches
   it across the task state graph.
3. **Reusable GitHub Action operations**
   `ainame/octestra` provides the shared operations needed to build repository-specific
   workflows, including state updates, prompt preparation, ownership, review requests, proof
   rendering, and failure reporting. The installer decides which repository and ref the generated
   workflows call; see [Which Octestra the workflows call](#which-octestra-the-workflows-call).

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
- Verifies the field has the seven status options Octestra requires, and prints the command to add
  any that are missing
- Installs and renders the workflows and prompts, pointing them at upstream's newest version tag or
  at your organization's own fork
- Installs `.github/octestra/octestra.sh` for diagnosing and maintaining the installation
  afterwards, and uses it for the initial variable sync
- Installs the EPIC setup skill into the selected `.claude`, `.codex`, or `.agents` directory
- Overwrites generated workflows, prompts, and the selected agent skill on every run

Use `--org` or `--status-field` to override the inferred defaults:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh |
  bash -s -- --org example-org --status-field "AI Task Status" --skill-target codex
```

### Which Octestra the workflows call

The generated workflows call Octestra as a GitHub Action, so their `uses:` reference decides whose
code runs in the consumer repository. The installer asks which repository that should be:

1. `ainame/octestra`, pinned to its newest version tag — or `main` while it has no tags.
2. `ORGANIZATION/octestra`, a fork owned by the consumer's own organization, tracking that fork's
   default branch. Fork the repository into the organization before choosing this.

Choose the fork to run only code your organization controls. In exchange, merging upstream changes
into the fork becomes your job, and the reference follows that fork's default branch rather than a
release.

Option 1 resolves to the exact version (`v1.2.3`), not the moving major tag (`v1`) that each
release also updates, so the code a consumer runs cannot change until they rerun the installer or
`octestra.sh ref`. Pass `--ref v1` if you would rather pick up patches automatically.

Noninteractive installs take option 1 unless `--fork` or `--repository OWNER/REPO` is passed, and
`--ref REF` overrides the resolved ref for either choice. The installer downloads its templates from
the same repository and ref it writes into the workflows, and reports the result as
`Octestra: generated workflows will call OWNER/REPO@REF`. Rerun the installer to move an existing
installation to a newer tag or to a different repository.

```sh
curl -fsSL https://raw.githubusercontent.com/example-org/octestra/refs/heads/main/install.sh |
  bash -s -- --fork
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
agent. Edit that file and run `.github/octestra/octestra.sh vars sync` to mirror the platform values
into repository variables. Keep `OCTESTRA_GITHUB_APP_PRIVATE_KEY` in GitHub Actions Secrets; add
agent credentials only when the chosen agent integration needs them. The workflows use an App token
instead of `GITHUB_TOKEN` so lifecycle field updates and agent pushes can trigger follow-up
workflows.

### Maintaining an installation

The installer leaves `.github/octestra/octestra.sh` beside `config.yml`. It needs only an
authenticated GitHub CLI, and it is reinstalled on every `install.sh` run, so keep repository
policy in `config.yml` rather than in the script.

```sh
.github/octestra/octestra.sh doctor
```

`doctor` reads only, and reports each way an installation breaks: a repository variable that
drifted from `config.yml` or was never set (an unset variable routes nothing), a missing
`OCTESTRA_GITHUB_APP_PRIVATE_KEY` (checked by name — no secret value is read), an Issue Field that
was renamed or whose ID no longer matches, a missing status option, a status job whose reusable
workflow is absent, a prompt path that points nowhere, and which Octestra the workflows call
together with any newer tag available. It exits non-zero when it finds a problem.

The other two commands change things:

- `vars check` exits non-zero on drift; `vars sync` **writes this repository's Actions variables**
  from `config.yml`, printing each one it sets.
- `ref` prints the Octestra repository and ref the workflows call. `ref OWNER/REPO@REF`, `ref @REF`,
  `ref OWNER/REPO`, and `ref --latest` **edit the workflow files in your checkout** (and the
  reference recorded in the script itself, so the two cannot disagree). Review and commit the diff
  to put a switch into effect — this is how an installation moves to a newer tag or onto your
  organization's fork after the fact.

## Operations

Octestra exposes aggregate lifecycle operations for the generated workflows and individual
operations for consumers that need custom sequencing or policy.

Generated state workflows pass shared issue, status, and trigger data through named
action inputs (`issue-number`, `previous-status`, `current-status`, `trigger-actor`,
`trigger-actor-type`). Aggregate operations infer their fixed lifecycle behavior:

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

Two optional `epic-config` booleans decide how a finished task PR is handed over, and both default
to `false`. `draft_pr: true` makes the agent open a draft; otherwise the pull request is created
ready for review. `skip_validation: true` sends a finished task straight to `Human Review`;
otherwise it goes through `Validation` first. Because that is the default, set
`skip_validation: true` in an EPIC's configuration until the generated validation workflow has a
real validation agent — its placeholder step fails, which moves the task to `Blocked`. Whenever Octestra requests review — after task
execution with `skip_validation: true`, or after validation passes — it takes the pull request out
of draft first, so a review request never points at a PR GitHub still marks unfinished. Octestra
does not assign anyone to the pull request; the task owner is the assignee of the *issue*, and
review is requested from them.

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
| Aggregate | `finalize-task` | Resolves the task branch and pull request, optionally marks it ready for review and requests review, updates status, and records task activity. |
| Aggregate | `prepare-validation` | Builds validation context, resolves the linked pull request, renders the validation prompt, and provides the result path. |
| Aggregate | `finalize-validation` | Reports proof and, for a passed result, marks the pull request ready for review, requests review from the task owner, and moves the task to the configured success status; other outcomes move to the failure status. |
| Aggregate | `finalize-merged-task` | Moves a `Human Review` task to `Done` when GitHub closes it as part of a linked pull request merge. |
| Individual | `assign-owner` | Assigns the user who triggered the task transition while preserving the existing owner for bot transitions. |
| Individual | `build-task-context` | Loads task and EPIC configuration, renders the task prompt, configures co-authorship, and publishes task outputs. |
| Individual | `build-validation-context` | Loads task and EPIC configuration, resolves the linked pull request, renders the validation prompt, and publishes validation outputs. |
| Individual | `resolve-task-pr` | Resolves the open pull request for a task branch and publishes its number. |
| Individual | `report-proof` | Renders consumer-owned proof JSON as a reviewer-focused issue comment without changing lifecycle status. |
| Individual | `request-review` | Takes the pull request out of draft, then requests review from the latest human Issue task owner. |
| Individual | `update-status` | Updates the configured organization Issue Field to the requested status. |
| Failure | `report-failure` | Records workflow failure details and moves the task to the configured failure status. |

## Proof reporting

The `report-proof` operation reads a consumer-generated JSON file, posts a concise table-based issue
comment, and exposes the reported outcome without touching lifecycle status. Acceptance criteria,
checks, and evidence remain consumer-owned.

```yaml
- name: Report validation proof
  id: proof
  uses: ainame/octestra@main
  with:
    operation: report-proof
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

## Configuration control plane

Installation creates `.github/octestra/config.yml`, the source of truth for platform values, branch
templates, and prompt paths. Four values are mirrored into
repository variables: `OCTESTRA_GITHUB_APP_CLIENT_ID`, `OCTESTRA_ORCHESTRATION_RUNNER`,
`OCTESTRA_AGENT_RUNNER`, and `OCTESTRA_STATUS_FIELD_ID`. Run
`.github/octestra/octestra.sh vars check` to detect drift and `vars sync` to apply, or `doctor` to
see drift alongside every other problem. Prompts are read from the checkout under
`.github/octestra/prompts`, at the paths `config.yml` names.

Installed workflows are `octestra-lifecycle.yml` and the lifecycle in-progress and validation
reusable workflows. Lifecycle operations use the `lifecycle/<verb>` namespace; old lifecycle names
are deprecated aliases.

## Development

```sh
npm ci
make all
```

`dist/index.js` is committed because it is the GitHub Actions runtime bundle.

`AGENTS.md` is the contract for changing this repository: layout, platform invariants, code style,
and the review checklist. `docs/design.md` records why the system is shaped the way it is, and
`TODO.md` tracks open work.
