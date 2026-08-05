# Glossary

The names Octestra invents, and the wording to introduce them with.

`AGENTS.md` requires that a term existing only in this project is defined where a reader first meets
it. Doing that consistently across three workflow templates, a README, a maintenance script and two
prompts fails in practice, because every author reinvents the phrasing and the wordier attempts
drift into a chatty register. This file holds the phrasing so nobody has to invent it.

Two rules keep it worth reading:

- **A term not listed here is not a term.** Needing a new one means adding it here first.
- **Delete a term that appears in no file.** Vocabulary nothing uses is the documentation form of
  dead configuration.

## Terms a consumer reads

These appear in `templates/`, in `README.md`, or in text Octestra posts to an issue. Each entry
gives the definition, and where the term needs introducing, the wording to use on first mention.
Use the short name after that.

### AI Task Status

The organization Issue Field whose value drives everything. Changing it on a task issue is what
starts a workflow run. The name is the installation's own — `status.field_name` in `config.yml` — so
write it as a value, not as a fixed noun.

> the `AI Task Status` Issue Field on your organization

### status option

One of the seven values `AI Task Status` may hold: `Todo`, `Ready`, `In Progress`, `Validation`,
`Human Review`, `Blocked`, `Done`. Octestra sets a status by its display name, so renaming an option
in the organization breaks the installation. Never call these "states" in consumer-facing text — the
GitHub UI calls them options.

### EPIC

The parent issue holding the configuration its task issues share: the branch namespace, the prompt
text, and whether validation runs.

> an EPIC issue — the parent issue whose `epic-config` block configures every task issue under it

### task issue

A sub-issue of an EPIC, and one unit of agent work. Needs no introduction beyond "task issue".

### task branch

The branch Octestra expects the agent to push, rendered from `branch.task` in `config.yml`. Both
finalization and validation resolve the same name independently, so an agent that pushes elsewhere
looks to Octestra like an agent that did nothing.

### task owner

The human assigned to the task issue. Review is requested from this person, and agent commits carry
them as co-author. Not the pull request assignee — Octestra sets none.

### operation

What the `operation:` input names. Two spellings are both correct and the difference is deliberate
(D9): `lifecycle/<verb>` for anything tied to one task's state, a bare verb for the pieces that are
scope-neutral, such as `update-status`.

### proof

The JSON file a validation agent writes to `result_path`. Octestra renders it as an issue comment
and reads `outcome`; it checks nothing inside `acceptance` or `checks`.

> a proof file — the JSON document your validation agent writes to `result_path`

### status job

A job in `octestra-lifecycle.yml` that runs when a task reaches one status option. Each one calls
its own workflow file.

### `OCTESTRA_AGENT_GITHUB_TOKEN`

The environment variable through which a lifecycle workflow passes the agent's GitHub token to its
local composite action.

### issue body blocks

The fenced blocks Octestra parses out of issue bodies: `epic-config`, `epic-task-prompt`, and the
optional `epic-validation-prompt` in an EPIC, plus `task-config`, `task-prompt`, and the optional
`validation-prompt` in a task issue. Refer to them by their literal names.

### issue-body contract

The Markdown template defining the fenced blocks in an EPIC or task issue. Setup skills render
these installed templates rather than creating their own issue-body format.

> each issue-body contract — the Markdown template defining the fenced blocks in an EPIC or task
> issue

### the maintenance CLI

`.github/octestra/octestra.sh`, installed beside `config.yml`. Prefer naming the file over the
phrase, since the reader can see the file.

## Terms only a contributor reads

Legitimate vocabulary in `AGENTS.md`, `docs/`, `TODO.md` and commit messages. **None of these may
appear in `templates/`, in `README.md`, or in anything Octestra posts to an issue** — a consumer has
no way to resolve them, which is the rule these exist to illustrate.

The ban is on prose. An identifier a consumer's own YAML has to contain — `status_key`,
`task_ready`, `transition_valid` — is not vocabulary and cannot be paraphrased away; document what
it holds where it appears.

| Term | Means |
|---|---|
| trust boundary | The intended separation between a job running an agent and a job holding a privileged token. Not implemented; see `TODO.md` §2. |
| control plane | `config.yml` plus the four repository variables mirrored from it. |
| mechanism / policy | What Octestra owns versus what the consumer decides. Workflows are mechanism; installed agent actions are policy. |
| seam | A split kept deliberately for work that has not landed, such as the unused `loop/` namespace. |
| the guard | The `guard` job, and `lifecycle/validate-transition` inside it, which decides whether a status change is legal and which status job to run. |
| mirrored value | One of the five values copied from `config.yml` into repository variables because a job needs them before it can read a file. |
| drift | A mirrored value disagreeing with `config.yml`. |
| platform invariant | A verified GitHub behaviour, numbered `P1`–`P11` in `AGENTS.md`. Numbers are stable and never reused. |
| decision | A design choice, numbered `D3`–`D14` in `docs/design.md`. |
| lifecycle / loop namespace | The two operation namespaces. Only `lifecycle/` exists today. |
