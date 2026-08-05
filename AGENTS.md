# Working on Octestra

Contract for anyone — human or agent — changing this repository. `README.md` is for people
*installing* Octestra; this file is for people *building* it. `docs/design.md` explains why the
system is shaped the way it is; read it before changing structure rather than behaviour.

## What this repository is

Octestra is a **framework**: Octestra owns the mechanism, the consumer owns the policy. Anything a
consumer might reasonably want to change — which agent runs, what it is allowed to do — must be
reachable by editing an installed file, not by forking Octestra.

One system sits on the shared control plane:

| System | Trigger | Entry point | Unit of work |
|---|---|---|---|
| Lifecycle | `issues: [field_added, closed]` | `octestra-lifecycle.yml` | one task issue moving through the state graph |

```
issues:field_added ─▶ octestra-lifecycle.yml ─┬─▶ octestra-lifecycle-in-progress.yml
                       (guard emits status_key)└─▶ octestra-lifecycle-validation.yml
```

A second system — scheduled loops sweeping many issues — is planned, not present, which is why
the `lifecycle/<verb>` operation namespace, the `src/lifecycle/` ⁄ `src/shared/` split and the
`lifecycle` infix in the workflow filenames are seams held open for it rather than leftovers to tidy
away (see `TODO.md` §1).

## Layout

```
action.yml                     composite action surface (inputs are the public API)
src/
  index.ts                     operation dispatch; builds context per namespace
  shared/                      config.ts, github-client.ts, prompt.ts, proof.ts
  lifecycle/operations.ts      lifecycle/<verb> implementations
dist/index.js                  committed esbuild bundle — regenerate, never hand-edit
templates/.github/
  workflows/                   no placeholders; install.sh rewrites only the action ref and OIDC
  octestra/config.yml          the ONLY file install.sh generates
  octestra/octestra.sh         installed maintenance CLI: doctor, update, vars check|sync, ref
  octestra/prompts/            handlebars prompts, read from the consumer's checkout
install.sh, test/install.test.sh
docs/design.md                 decisions and rationale
docs/glossary.md               canonical names, and the wording to introduce each one with
```

## Build, test, verify

```sh
make all          # typecheck + vitest + ruby tests + install tests + rebuild bundles
```

`make all` must be green before any commit. It rebuilds `dist/index.js`, so commit that alongside
source changes or the action ships stale code.

Targeted loops while iterating: `npx vitest run src/lifecycle`, `bash test/install.test.sh`.

There is no make target for the mirrored repository variables or for updating an installation: both
jobs belong to a *consumer* repository, and `templates/.github/octestra/octestra.sh` is installed
there to do them (`octestra.sh vars check|sync`, `octestra.sh update`). `install.sh` runs the copy
it just installed for the initial sync, so every install exercises the tool consumers rely on
afterwards.

## Platform invariants

Each of these was verified against GitHub documentation and cost real debugging. Violating one
produces silent misbehaviour rather than an error, which is why they are listed rather than left to
be rediscovered. The numbering is stable, so the list has gaps where invariants about loop machinery
were removed with it — the removal commit quotes those verbatim and they return with loops. Never
renumber: `docs/design.md` cites these numbers.

- **P1. Status option *names* are part of the contract, because the write API gives no
  alternative.** `POST .../issue-field-values` takes `{field_id, value}` and accepts a single_select
  value only as the option's *display name* — there is no `single_select_option_id`. So
  `allowedTransitions`, `updateStatus`, `getStatus` and `status_key` all key on the display name.
  Reads *could* be ID-addressed (`GET` returns `issue_field_id` and `single_select_option.id`), but a
  half-ID design buys nothing while writes still need the name, so names are the single vocabulary
  and `config.yml` carries no option IDs — only `field_name` and `field_id`. Do not introduce a
  second vocabulary.
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
- **P7. `secrets: inherit` is all-or-nothing.** A reusable workflow that executes an agent must not
  inherit; it declares agent credentials under `on.workflow_call.secrets` and the caller passes them
  explicitly.
- **P8. Concurrency groups are repository-scoped.** Identical group strings in different workflow
  files share a group. `octestra-lifecycle-in-progress.yml` relies on this: its
  `octestra-<issue_number>` group with `cancel-in-progress: false` serialises work on one task issue,
  so a repeated transition queues instead of putting a second agent on the same branch. Any workflow
  added later that touches a task issue must reuse that group string rather than invent its own.
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

**Configuration.** `.github/octestra/config.yml` is the single source of truth. Exactly five values
are mirrored into repository variables (`OCTESTRA_GITHUB_APP_CLIENT_ID`,
`OCTESTRA_GITHUB_APP_PRIVATE_KEY_SECRET`, `OCTESTRA_ORCHESTRATION_RUNNER`,
`OCTESTRA_AGENT_RUNNER`, `OCTESTRA_STATUS_FIELD_ID`) because they
are needed before a job starts and no file can be read then. Adding a sixth needs a reason that
survives P3. Everything else is read at runtime.

Config is read from the **default branch via the Contents API**, never from the checkout — jobs
without a checkout must still read it, and the control plane must not come from a workspace an
agent may have modified. Prompts are the opposite: they are agent-facing content that should be
reviewable in a pull request, so they are read from the checkout.

**Templates are consumer-facing source code.** Files under `templates/` are read and edited by
people who did not write Octestra. Use block style, not YAML flow mappings. Comment the parts a
consumer is expected to change. `config.yml` is the only *generated* file: nothing under
`templates/.github/workflows/` may contain a placeholder, because every template must also be
runnable as committed.

`install.sh` does rewrite installed workflows, but only from one valid value to another — it
uncomments `id-token: write` for `--enable-oidc`, and `rewrite_action_references` repoints
`uses: ainame/octestra@main` at the repository and ref that installation tracks (D11). A rewrite
whose *input* is not valid on its own is a placeholder by another name; that value belongs in
`config.yml`. Write the shipped literal `ainame/octestra@main` in any new template — the rewrite
finds it with or without a `/subpath`, and fails the install loudly if a reference survives
unrewritten.

**Consumer-facing text is low-context.** Template comments, `README.md` and the prompts are read
by someone who has never seen this repository, so they must not lean on its vocabulary. Name the
thing, not the concept: "the step that creates the App token", not "the trust boundary".

A term that exists only here is *defined where the reader first meets it, and used normally after
that*. Octestra's own nouns are the trap, because they read as ordinary English — nothing warns a
consumer that *custom region* is a term. So introduce it: "each custom region — the lines enclosed
by a matching pair of `# octestra:custom:begin <name>` and `# octestra:custom:end <name>` markers".
Do not instead avoid the term. Circumlocution costs more words at every recurrence and drifts into
a chatty register ("what you wrote between…"), which is the wrong voice for a file someone edits in
their production repository.

`docs/glossary.md` carries that first-mention wording for every term, and separates the terms a
consumer reads from the ones only a contributor may use. Take the phrasing from there rather than
inventing one, and add a new term there before it reaches a template.

Say what the reader must do and what breaks if they do not — that is what earns a comment its
place. Do not describe what Octestra intends to do in a later release: the reader can neither
verify nor act on it, and the sentence rots on its own. `AGENTS.md`, `docs/design.md` and
`TODO.md` are the opposite. They are written for people building Octestra, so the internal
vocabulary, the invariant numbers and the roadmap belong there and only there.

**Custom regions are the update contract (D14).** A rerun of `install.sh` replaces an installed
workflow except for the parts between `# octestra:custom:begin <name>` and
`# octestra:custom:end <name>`, whose contents it carries into the new version. So the line between
mechanism and policy is now written into the templates themselves, and it cuts both ways:

- Content a consumer is expected to write goes **inside** a region. If it is outside one, every
  update silently discards it.
- Content Octestra needs to keep updating — `prepare-*`, `finalize-*`, the guard, the permissions
  ceiling (P11) — stays **outside**. Anything you put inside a region freezes at the version each
  consumer installed, and you cannot fix it for them later.

Give a region the narrowest scope that holds one decision (`agent-credentials`, not `the whole
job`). Never rename or drop a region without accepting that every installation that used it gets a
`.octestra-bak` file and a manual migration. Every template that declares a region also documents
it in the file's header comment, because that comment is where a consumer looks first.

A region has an *interface*, and it is as binding as the region name. Carried-over content may
reference only `steps.epic.outputs.*`, `env.OCTESTRA_*`, and the `secrets`/`vars`/`inputs` the
template declares — never another step's id. A `steps.<id>` naming something outside the region
couples content you cannot edit to a step you must be free to move, and the failure is silent
rather than loud: GitHub resolves a reference to an absent step to `''`, so the update succeeds,
`doctor` passes, and the agent runs with an empty value. Anything a region needs from Octestra is
therefore published under a stable `OCTESTRA_*` name by a step outside it — which is what
`OCTESTRA_AGENT_GITHUB_TOKEN` exists for. `test/install.test.sh` fails when a template breaks this.

The consumer's entry point is `octestra.sh update`, which downloads a reference and runs **that
version's** `install.sh` against the repository. Two consequences:

- The merge, the action-reference rewrite and the variable sync live in `install.sh` only. Do not
  reimplement any of them in `octestra.sh`; an update is meant to run the new logic, not the old.
- The flags `update` passes — `--target`, `--source-dir`, `--org`, `--status-field`,
  `--skill-target`, `--github-app-client-id`, `--repository`, `--ref`, `--yes`, `--enable-oidc` —
  are a compatibility surface with *older installed scripts*. Removing or renaming one breaks
  `update` for every installation that predates the change.

Anything that lives outside a custom region and that a consumer can still toggle must be
reconstructed by `update` from the installed state, the way `--enable-oidc` is recovered by looking
for an uncommented `id-token: write`. A new toggle of that kind needs the same treatment or an
update silently reverts it.

**config.yml survives an update.** `install.sh` renders it only when the file does not exist; a
rerun keeps the consumer's copy and reports any value it resolved that the file contradicts. So a
new key added to the template does *not* reach existing installations: give it a defined behaviour
when absent, or expect `doctor` to be the thing that tells consumers to add it.

**No dead configuration.** A key that `config.yml` documents must be read by code. A knob that
validates but does nothing is worse than an absent knob, because it advertises a guarantee that
does not exist. The same applies to instructions: a maintenance step the documentation tells a
consumer to run must be reachable *from their repository*, which is why the mirroring tool is
installed rather than kept here (D12).

**The installed maintenance CLI.** `templates/.github/octestra/octestra.sh` is the only
executable Octestra installs, and it needs nothing but `gh` — no node, no `yq` — because it runs
in repositories of any language. It owns config → variable mirroring and it is the entry point for
updates; do not add a second implementation of either. Two things it must know are also known by
`install.sh` — the seven status option names, and how a version tag is resolved — so a change to
either belongs in both files, and `test/install.test.sh` fails when the status lists drift apart.

It also runs where `/bin/bash` is 3.2, which the tests cover by driving one install and one update
through it. In particular `"${array[@]}"` on an empty array is a fatal error there under `set -u`;
write `${array[@]+"${array[@]}"}`.

**Trust boundary.** A job that executes an agent gets no privileged token, checks out with
`persist-credentials: false`, and runs no lifecycle operation. Results cross into a trusted job as
a bounded, strictly validated artifact, and that job mints a fresh App token. **No workflow
implements this yet** — the lifecycle workflows hand the agent job an App token and run
`finalize-task` beside the agent, which is the largest security gap in the repository (see
`TODO.md` §2). Treat the rule as binding on anything new, and do not widen the gap while it is open.

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
8. Does new consumer-facing text stand on its own, or does it require this repository's vocabulary
   and promises about a later release?
