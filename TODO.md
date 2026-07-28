# TODO

Open work, ordered by what unblocks what. Design rationale lives in `docs/design.md`; the rules this
work must respect live in `AGENTS.md`.

The Loop and configuration restructuring has shipped: the config control plane, the two-layer
lifecycle topology, operation namespacing, and both loop shapes (per-issue fan-out and aggregate).
Everything below is what remains.

## 1. `loop/create-task`

A loop can comment on and promote existing tasks, but cannot create them. Closing that gap — letting
a loop open sub-issues under an EPIC from its own analysis — is what turns Octestra from a task
executor into a feedback cycle.

Design questions to settle first: what bounds creation (a per-run cap belongs in `apply`), how
duplicates are suppressed across runs given P5, and whether created tasks start in `Todo` for a
human or enter the lifecycle directly.

## 2. Migrate the lifecycle to the loop trust boundary

Loop workflows already separate agent execution from privileged finalization (`docs/design.md` §4).
The lifecycle workflows do not: `finalize-task` still runs in the same job as the agent. This is the
largest security gap in the repository.

Octestra workflows execute a repository-configured coding agent with access to repository content,
issue instructions, dependency output, and potentially GitHub or cloud credentials. Private
repositories reduce who can supply malicious input but do not reduce the impact once an agent or a
command is compromised.

The target, mirroring what loops already do:

- Separate agent-controlled execution from trusted lifecycle finalization.
- Read-only checkout tokens with `persist-credentials: false`.
- No repository write token for validation agents by default.
- If an agent must comment, a short-lived token limited to repository read plus issue and pull
  request write, revoked immediately afterwards.
- A fresh lifecycle token minted in a separate job that does not execute pull request code.
- Validation proof transferred to that job as bounded, strictly validated data.
- A default-branch ruleset the task App cannot bypass. Task agents still need write access to create
  their own branches.
- OIDC roles, model credentials, network access, and persistent self-hosted runners treated as
  separate risks: isolated ephemeral runners, narrowly scoped non-production credentials.

An early implementation experiment is in the git stash named
`wip: validation token boundary experiment`.

### Open decisions (need a human, not an agent)

- Does Octestra support public consumer repositories, or does it document private, trusted-member
  repositories as its initial security boundary?
- Must the agent post comments directly, or can trusted finalization render every comment from
  agent-produced proof?
- Should comment tokens be opt-in rather than present in generated defaults?
- What cloud and network isolation is required when validation uses Bedrock or another hosted model?

## 3. Address status options by ID

P1 in `AGENTS.md`: `allowedTransitions`, `updateStatus`, and `getStatus` key on the status display
name while identity is the option ID. Renaming an option in the organization's Issue Field breaks
the operations. It also breaks `install.sh`, so today it fails at setup rather than silently — the
only reason this is not urgent.

`GET`/`POST .../issue-field-values` accept `single_select_option_id`, so operations can address
options by ID and reduce names to presentation. `config.yml` already carries the seven option IDs
and the transition guard already routes on them, so the remaining work is confined to
`src/lifecycle/operations.ts` and its transition table.

Acceptance: renaming a status option in the organization leaves a working installation working.

## 4. `install.sh` hardening

- Validate that the resolved status options match the seven Octestra expects, and fail with the
  mismatch rather than writing a `config.yml` that only breaks later.
- Re-running the installer over an existing installation should preserve consumer edits to
  `config.yml`; today it regenerates the file.
- The installer overwrites workflows, prompts, and the agent skill on every run. Say so before doing
  it.

## 5. Remove deprecated aliases

`src/index.ts` maps nine bare operation names to their `lifecycle/` equivalents and warns. They were
kept for one release. Remove the alias table and its warning once consumers have migrated.
