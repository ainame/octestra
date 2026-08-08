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
issues:field_added ─▶ octestra-lifecycle.yml
                       guard ─┬─▶ in-progress
                              └─▶ validation
```

A second system — scheduled loops sweeping many issues — is planned, not present, which is why
the `lifecycle/<verb>` operation namespace, the `src/lifecycle/` ⁄ `src/shared/` split and the
`lifecycle` infix in the workflow filename are seams held open for it rather than leftovers to tidy
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
  workflows/octestra-lifecycle.yml
                               lifecycle trigger, routing and status jobs
  octestra/actions/            consumer-owned task and validation agent composite actions
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
  This lets status jobs select their runners directly without a bootstrap job.
- **P3. An unset `vars` evaluates to `''`**, which casts to `0` in a numeric comparison and produces
  a silent no-match. Routing comparisons must be string comparisons
  (`format('{0}', x) == vars.Y`); runner labels must carry a literal fallback
  (`${{ vars.X || 'ubuntu-latest' }}`); drift must fail loudly.
- **P8. Concurrency groups are repository-scoped.** Identical group strings in different workflow
  files share a group. The `in-progress` and `validation` jobs use the same
  `octestra-<issue_number>` group with `cancel-in-progress: false`, so work on one task issue is
  serialized. Any workflow added later that touches a task issue must reuse that group string rather
  than invent its own.

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

`install.sh` does rewrite the installed workflow, but only from one valid value to another — it
uncomments `id-token: write` for `--enable-oidc`, and `rewrite_action_references` repoints
`uses: ainame/octestra@main` at the repository and ref that installation tracks (D11). A rewrite
whose *input* is not valid on its own is a placeholder by another name; that value belongs in
`config.yml`. Write the shipped literal `ainame/octestra@main` in any new template — the rewrite
finds it with or without a `/subpath`, and fails the install loudly if a reference survives
unrewritten.

**Consumer-facing text is low-context.** Template comments, `README.md` and the prompts are read
by someone who has never seen this repository, so they must not lean on its vocabulary. Name the
thing, not the concept: "the step that creates the App token", not "the trust boundary".

`docs/glossary.md` carries that first-mention wording for every term, and separates the terms a
consumer reads from the ones only a contributor may use. Take the phrasing from there rather than
inventing one, and add a new term there before it reaches a template.

Say what the reader must do and what breaks if they do not — that is what earns a comment its
place. Do not describe what Octestra intends to do in a later release: the reader can neither
verify nor act on it, and the sentence rots on its own. `AGENTS.md`, `docs/design.md` and
`TODO.md` are the opposite. They are written for people building Octestra, so the internal
vocabulary, the invariant numbers and the roadmap belong there and only there.

The consumer's entry point is `octestra.sh update`, which downloads a reference and runs **that
version's** `install.sh` against the repository. Two consequences:

- The workflow replacement, action preservation, action-reference rewrite and variable sync live in
  `install.sh` only. Do not
  reimplement any of them in `octestra.sh`; an update is meant to run the new logic, not the old.
- The flags `update` passes — `--target`, `--source-dir`, `--org`, `--status-field`,
  `--skill-target`, `--github-app-client-id`, `--repository`, `--ref`, `--yes`, `--enable-oidc` —
  are a compatibility surface with *older installed scripts*. Removing or renaming one breaks
  `update` for every installation that predates the change.

The installed lifecycle workflow belongs to Octestra and is replaced on update. The task and
validation composite actions belong to the consumer after their first installation, so updates
preserve them in full. Octestra may extend the inputs passed by its workflow, but must not depend on
updating an already-installed action to consume them. Any workflow toggle, such as `--enable-oidc`,
must be reconstructed by `update` from the installed state or an update silently reverts it.

**Agent execution stays with preparation.** Lifecycle preparation, agent execution and finalization
share one job and runner instance. Do not split preparation into a producer job merely to condition
the agent job: that starts another runner and loses the workspace and process environment
preparation just established. The local task and validation composite actions are the boundaries
for repository-owned setup and execution steps.

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

**Trust boundary.** Octestra initially targets private repositories whose members are trusted to
run coding agents. The lifecycle workflow therefore favors one readable job graph over isolating
each agent behind a separate permission boundary: agent jobs inherit the workflow's write
permissions, receive an App token, and run finalization beside the agent. This does not protect
against a compromised agent, dependency or command. The intended stronger boundary remains in
`TODO.md` §2; do not add further credentials or permissions without documenting the threat and
trade-off there.

**Style.** Conventional multi-line TypeScript: one statement per line, named `function`
declarations, no chained statements on a single line. Match `src/lifecycle/operations.ts`. The same
applies to tests and to workflow templates.

**Tests.** Every operation needs unit tests using the fake-client pattern in
`src/lifecycle/operations.test.ts`. Cover the success path, not only the rejections — the expensive
bugs in this repository have been silently-inert code paths, not loud failures. Interface methods
that operations depend on must be **required**, never optional, so a missing implementation is a
type error instead of a runtime `undefined`.

**Commits.** Every commit, including a pull request's squash-merge commit, must use a
[Conventional Commit](https://www.conventionalcommits.org/) prefix. Release Please reads these
messages to create releases: `fix:` produces a patch release, `feat:` produces a minor release,
and `!` or a `BREAKING CHANGE:` footer produces a major release. Use an appropriate non-releasing
prefix such as `docs:`, `test:`, `chore:`, or `refactor:` when the change should not release.

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
