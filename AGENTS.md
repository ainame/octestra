# Working on Octestra

Contract for anyone — human or agent — changing this repository. `README.md` is for people
*installing* Octestra; this file is for people *building* it. `docs/design.md` explains why the
system is shaped the way it is; read it before changing structure rather than behaviour.

## What this repository is

Octestra is a **framework**: Octestra owns the mechanism, the consumer owns the policy. Anything a
consumer might reasonably want to change — which loops exist, when they run, which agent runs,
what it is allowed to do — must be reachable by editing an installed file, not by forking Octestra.

Two systems sit on top of one shared control plane:

| System | Trigger | Entry point | Unit of work |
|---|---|---|---|
| Lifecycle | `issues: [field_added, closed]` | `octestra-lifecycle.yml` | one task issue moving through the state graph |
| Loop | `schedule` + `workflow_dispatch` | `octestra-loop-<id>.yml` | one scheduled sweep over many issues |

```
issues:field_added ─▶ octestra-lifecycle.yml ─┬─▶ octestra-lifecycle-in-progress.yml
                       (guard emits status_key)└─▶ octestra-lifecycle-validation.yml

schedule / dispatch ─▶ octestra-loop-<id>.yml   (select ─▶ agent ─▶ trusted finalize)
                              │
                              └── guarded status update ─▶ issues:field_added ─▶ lifecycle
```

Loops never bypass the state machine: a loop that changes status emits a real Issue Field event and
the lifecycle observes it normally.

## Layout

```
action.yml                     composite action surface (inputs are the public API)
src/
  index.ts                     operation dispatch; builds context per namespace
  shared/                      config.ts, github-client.ts, prompt.ts, proof.ts
  lifecycle/operations.ts      lifecycle/<verb> implementations
  loop/operations.ts           loop/<verb> implementations
dist/index.js                  committed esbuild bundle — regenerate, never hand-edit
proof/                         separate action for rendering consumer proof JSON
templates/.github/
  workflows/                   installed byte-identically; no placeholder substitution
  octestra/config.yml          the ONLY file install.sh generates
  octestra/prompts/            handlebars prompts, read from the consumer's checkout
install.sh, test/install.test.sh
scripts/octestra-vars.{mjs,sh} config.yml -> repository variables
docs/design.md                 decisions and rationale
```

## Build, test, verify

```sh
make all          # typecheck + vitest + ruby tests + install tests + rebuild bundles
```

`make all` must be green before any commit. It rebuilds `dist/index.js` and `proof/dist/index.js`,
so commit those alongside source changes or the action ships stale code.

Targeted loops while iterating: `npx vitest run src/loop`, `bash test/install.test.sh`.

`make octestra-check-vars` / `make octestra-sync-vars` compare and push the four mirrored
repository variables. These act on a *consumer* repository, not on this one.

## Platform invariants

Each of these was verified against GitHub documentation and cost real debugging. Violating one
produces silent misbehaviour rather than an error, which is why they are listed rather than left to
be rediscovered.

- **P1. Status option *names* are part of the contract, because the write API gives no
  alternative.** `POST .../issue-field-values` takes `{field_id, value}` and accepts a single_select
  value only as the option's *display name* — there is no `single_select_option_id`. So
  `allowedTransitions`, `updateStatus`, `getStatus`, `status_key`, and loop `select.status` /
  `apply.allowed_status` all key on the display name. Reads *could* be ID-addressed (`GET` returns
  `issue_field_id` and `single_select_option.id`), but a half-ID design buys nothing while writes
  still need the name, so names are the single vocabulary and `config.yml` carries no option IDs —
  only `field_name` and `field_id`. Do not introduce a second vocabulary.
  Renaming an option in the organization therefore breaks the installation: the event's new name is
  absent from `allowedTransitions`, so the guard reports an invalid transition instead of routing,
  and `install.sh` reports the option as missing on its next run. That is loud rather than silent,
  which is the only reason this is tolerable. Revisit only if the write endpoint gains ID addressing;
  see `TODO.md` §3 for what was tried and why it was reverted.
- **P2. `vars` is available where `env` is not.** `vars` works in `jobs.<id>.runs-on`,
  `jobs.<id>.if`, `jobs.<id>.with.<id>`, `concurrency`, and `run-name`; `env` works in none of them.
  This is the reason the lifecycle is two layers instead of three.
- **P3. An unset `vars` evaluates to `''`**, which casts to `0` in a numeric comparison and produces
  a silent no-match. Routing comparisons must be string comparisons
  (`format('{0}', x) == vars.Y`); runner labels must carry a literal fallback
  (`${{ vars.X || 'ubuntu-latest' }}`); drift must fail loudly.
- **P4. `schedule` only runs on the default branch**, against its latest commit, and only if the
  workflow file exists there. A loop cannot be exercised from a pull request, so every loop must
  also offer `workflow_dispatch` with `dry-run` defaulting to `true`.
- **P5. `schedule` is best-effort** — delayed or skipped under load, and disabled after 60 days of
  repository inactivity. Every loop must be idempotent; correctness must never depend on a run
  happening exactly once per period.
- **P6. An empty `strategy.matrix` fails the job**, it does not skip it. A matrix built from
  `fromJSON(needs.<job>.outputs.<x>)` needs a job-level `if` guard (job `if` is evaluated before
  matrix expansion, so this is safe), and the guard output and the array must derive from the same
  validated value. The matrix limit is 256 jobs.
- **P7. `secrets: inherit` is all-or-nothing.** A reusable workflow that executes an agent must not
  inherit; it declares agent credentials under `on.workflow_call.secrets` and the caller passes them
  explicitly.
- **P8. Concurrency groups are repository-scoped.** Identical group strings in different workflow
  files share a group. Loops rely on this: `octestra-<issue_number>` interlocks a loop's per-issue
  job with lifecycle task execution.
- **P9. REST pagination offset is `(page - 1) * per_page`.** Varying `per_page` between pages of the
  same sweep re-fetches or skips records. Keep it constant and truncate afterwards.
- **P10. Reusable workflow nesting allows ten levels** (caller plus nine). Recorded because an
  earlier draft claimed four and constrained the design for no reason.
- **P11. A reusable workflow's `permissions:` block is a request, and the caller's workflow-level
  `permissions:` is the ceiling.** If the callee declares any permission the caller does not grant
  at workflow level, the run fails with `startup_failure` before any job is created — `jobs: []`,
  no check-runs, no logs, no annotated line, just the top-of-page banner saying the workflow file
  is broken. This applies to every permission, not only `id-token: write`. Consequences:
  (a) `octestra-lifecycle.yml` declares the *union* of everything its reusable workflows request
  (`contents: write`, `issues: write`, `pull-requests: write`), and each direct job narrows this
  at the job level. When adding a new reusable workflow with a new permission, extend the caller's
  workflow-level block first.
  (b) Reusable workflows must NOT declare `id-token: write`. Permissions a callee does not name
  are inherited from the caller, so OIDC steps inside a callee work as long as the caller has
  `id-token: write` — and the caller having it while a callee also declares it in `permissions:`
  is fine, but the moment a consumer toggles only one side by hand the two files drift, everyone
  ends up on the startup_failure path, and the fix is not obvious from any log. `id-token: write`
  therefore lives commented in exactly one place — the caller. `install.sh --enable-oidc` flips
  that single line.

## Rules

**Configuration.** `.github/octestra/config.yml` is the single source of truth. Exactly four values
are mirrored into repository variables (`OCTESTRA_GITHUB_APP_CLIENT_ID`,
`OCTESTRA_ORCHESTRATION_RUNNER`, `OCTESTRA_AGENT_RUNNER`, `OCTESTRA_STATUS_FIELD_ID`) because they
are needed before a job starts and no file can be read then. Adding a fifth needs a reason that
survives P3. Everything else is read at runtime.

Config is read from the **default branch via the Contents API**, never from the checkout — jobs
without a checkout must still read it, and the control plane must not come from a workspace an
agent may have modified. Prompts are the opposite: they are agent-facing content that should be
reviewable in a pull request, so they are read from the checkout.

**Templates are consumer-facing source code.** Files under `templates/` are read and edited by
people who did not write Octestra. Use block style, not YAML flow mappings. Comment the parts a
consumer is expected to change. `config.yml` is the only generated file — everything in
`templates/.github/workflows/` installs byte-identically, so nothing there may contain a
placeholder.

**No dead configuration.** A key that `config.yml` documents must be read by code. A knob that
validates but does nothing is worse than an absent knob, because it advertises a guarantee that
does not exist.

**Trust boundary.** A job that executes an agent gets no privileged token, checks out with
`persist-credentials: false`, and runs no lifecycle operation. Results cross into a trusted job as
a bounded, strictly validated artifact, and that job mints a fresh App token. Loop workflows already
follow this; the lifecycle workflows do not yet (see `TODO.md`). Do not widen the gap.

**Style.** Conventional multi-line TypeScript: one statement per line, named `function`
declarations, no chained statements on a single line. Match `src/lifecycle/operations.ts`. The same
applies to tests and to workflow templates.

**Tests.** Every operation needs unit tests using the fake-client pattern in
`src/lifecycle/operations.test.ts`. Cover the success path, not only the rejections — the expensive
bugs in this repository have been silently-inert code paths, not loud failures. Interface methods
that operations depend on must be **required**, never optional, so a missing implementation is a
type error instead of a runtime `undefined`.

**Never** commit secrets, hand-edit `dist/`, add a runtime dependency for something the vendored
`yaml` package already does, require `yq`, or use `secrets: inherit`.

## Review checklist

Derived from bugs that actually shipped into review here:

1. Does the feature run end to end, or does it terminate early on an unimplemented path?
2. Do the two sides of a comparison share a vocabulary? (A proof `outcome` and a status name do not.)
3. Do GitHub expressions inside YAML scalars survive quoting? `''` inside a single-quoted scalar is
   an escaped apostrophe, not an empty string — use a block scalar.
4. Are documented config keys actually consumed?
5. Do budget and limit parameters bound the work, or only the result?
6. Are new tests asserting the behaviour that would break, or only the guards around it?
7. Do new files match the style of the files beside them?
