# Working on Octestra

Octestra owns orchestration; consumers own agent policy. Keep consumer choices editable in
installed files. Read [docs/design.md](docs/design.md) when changing architecture or ownership,
and [docs/glossary.md](docs/glossary.md) when changing consumer-facing terminology.

## Working approach

Complete authorized work, making routine implementation choices from repository context. Ask only
when missing information materially affects scope or correctness. Explicit user instructions take
precedence over repository and skill guidance. Keep updates concise: describe the outcome, checks,
and any remaining blocker.

Keep this file focused on actionable repository constraints. Put design rationale in
`docs/design.md`, roadmap items in `TODO.md`, and installation guidance in `README.md`.

## Build and verify

Use Node.js 24+ and Ruby 4.0. Install dependencies with `npm ci`.

- Run `make all` before committing: typecheck, Vitest, Ruby and installer tests, then bundle rebuild.
- During iteration, use the relevant suite: `npx vitest run src/lifecycle`,
  `npx vitest run src/loop`, `make test-ruby`, or `make test-installer`.
- Never hand-edit `dist/`. Commit regenerated `dist/index.js` with source changes; CI rejects drift.
- Run `git diff --check`. Once required checks pass, repeat or broaden them only for new changes,
  failures or unresolved concerns. Documentation edits do not need new behavior tests.
- Test changed operations with the fake-client pattern in `src/lifecycle/operations.test.ts`,
  including success paths. Local fixtures do not prove live organization Issue Fields behavior.
- Commit each meaningful change. PR titles use Conventional Commit prefixes; use `docs:` for docs.
  Version tags omit `v`, despite the existing Release Please configuration's prefixed tags.

## Implementation contracts

- `action.yml` is the Node action API; `src/index.ts` dispatches to `src/lifecycle/operations.ts`
  and `src/loop/operations.ts`. Shared parsing and GitHub access live in `src/shared/`.
- Keep action inputs/outputs in `snake_case` and TypeScript in `camelCase`. Update declarations,
  dispatch, workflow wiring and tests together. Preserve supported compatibility inputs.
- Match the multi-line TypeScript style in lifecycle operations: named functions and one statement
  per line. Client methods used by operations must be required, not optional.
- Read action config through the Contents API (default branch or explicit `config_ref`), never
  from the agent's checkout. Read prompts from the checkout.
- `.github/octestra/config.yml` owns configuration. Keep its five mirrored repository variables
  in sync through the installed `octestra.sh vars check|sync`; justify any new mirrored value.
  `OCTESTRA_AGENT_DEBUG` is optional and is not mirrored from config.
- Give new config keys behavior when absent: updates preserve existing config. Document only keys
  the implementation consumes.
- Keep lifecycle preparation, agent execution and finalization in one job/runner. Honor
  `task_ready` before agent execution and finalization; pass prepared branch and validation policy
  together. Finish reporting and review requests before the status update that starts further work.
- Repository triage owns discovery, readiness policy and issue preparation. Octestra alone applies
  `Todo` to `Ready`: validate the whole result and parent EPIC before writes, then recheck each live
  status. Already-`Ready` tasks must produce no duplicate write or activity.
- Framework prompts invoke `/octestra-contracts` with one phase: `task`, `triage` or `validation`.
  Keep `src/shared/result.ts`, the installed `check-output.sh`, and contract examples aligned.
- Agent actions share the job's token, permissions and workspace. Document additional credentials
  or permissions and their trade-offs in `TODO.md` §1.

## Installation and templates

- `install.sh` owns template copying, preservation and action-reference rewriting.
  The installed `templates/.github/octestra/octestra.sh` owns variable mirroring and starts updates
  by running the downloaded version's installer. Preserve flags passed by older installed scripts.
- Updates replace the lifecycle workflow and framework contract skill; preserve existing config,
  agent actions, prompts and loop policy. The tracked action ref in the staged Todo loop is updated.
  Workflow changes must work with older consumer-owned actions and preserve the OIDC setting.
- Ship runnable templates with literal `ainame/octestra@main` references for installer rewriting.
  Only `config.yml` is generated. Use block-style YAML mappings and explicit shells in composite steps.
- Keep the maintenance CLI compatible with Bash 3.2, standard utilities and `gh`; require no Node
  or `yq`. For empty arrays under `set -u`, use `${array[@]+"${array[@]}"}`.
  Keep status names and tag resolution consistent between the CLI and installer.
- Write consumer comments and prompts in plain language using `docs/glossary.md`. Explain what
  users must do and what breaks otherwise. Keep internal terminology and future plans in contributor docs.

## Platform constraints

Keep these identifiers stable because design documentation cites them.

- **P1:** Address the status field by ID and status options by display name. `status_key` is the
  display name lowercased with spaces replaced by underscores; do not add an option-ID vocabulary.
- **P2:** Use `vars` for job-level runner selection and routing; `env` is unavailable there.
- **P3:** Unset variables become empty strings. Compare field IDs as strings and give runner labels
  literal fallbacks. Variable drift must be detectable through the maintenance CLI.
- **P4:** Scheduled runs use the default branch. Also expose `workflow_dispatch` for loops.
- **P5:** Scheduling is best-effort. Loops must be idempotent.
- **P6:** Guard empty matrices and reject discovery above 256 enabled EPICs; never truncate silently.
- **P8:** Task agent and validation jobs share `octestra-<issue_number>` concurrency with
  `cancel-in-progress: false`. Reuse it for new task jobs. Multi-task triage finalization instead
  relies on full preflight, live status rechecks and idempotent `Todo` to `Ready` writes.

Never commit secrets, use `secrets: inherit` or `swift-actions/setup-swift@v2`, require `yq`, or add
runtime dependencies for functionality already provided by `yaml`.
