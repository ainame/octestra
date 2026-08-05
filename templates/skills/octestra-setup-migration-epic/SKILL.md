---
name: octestra-setup-migration-epic
description: >
  Plan a large-scale code migration, confirm its task breakdown, and create Octestra
  EPICs and sub-issues in GitHub Projects.
disable-model-invocation: true
---

# Octestra migration EPIC setup

Use this skill to turn a migration plan into Octestra EPICs and task sub-issues. The
bundled `scripts/setup_epic.rb` performs deterministic GitHub operations; this skill is
responsible for repository analysis, user decisions, and manifest generation.

## Prerequisites

- `gh` is installed and authenticated.
- Ruby is available. No gems are required.
- The target is an organization-owned repository with Octestra installed.
- The organization Project has its **Auto-add sub-issues to project** workflow enabled.

## 1. Check the Octestra installation

Before collecting setup information or creating any issue, run:

```bash
.github/octestra/octestra.sh doctor
```

Continue only when it reports no problems. If it reports a missing GitHub App secret, unset
repository variable, or another failure, show the result to the user and stop. Do not create EPIC
or task issues until the installation is healthy.

## 2. Collect setup information

Ask for missing values one at a time:

| Value | Default |
| --- | --- |
| Migration title | Required |
| How to discover or define tasks | Required |
| Skill invoked for each task, such as `objc-to-swift` | Required; also becomes the EPIC ID and branch namespace |
| Organization Project number | Required |
| Draft pull requests | `false` |
| Skip agentic validation | `false` |
| Excluded paths or task patterns | Empty |

Infer the repository with:

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
```

If inference fails, ask for `owner/repository`. The Project owner defaults to the
repository organization. Use the Issue Field name configured in
`.github/octestra/config.yml`; it normally defaults to `AI Task Status`.

## 3. Build and confirm the task list

Analyze the repository using the user's discovery criteria. Exclude generated,
vendored, and explicitly excluded files unless requested.

Each task has:

- `title`: concise, human-readable issue title.
- `target`: repository-relative path, or `null` for work without one target file.

File-backed tasks may default their title to the target path. Standalone tasks should
use a descriptive title. Remove duplicates and present the final ordered list for
confirmation. Explain that Octestra creates one EPIC per 100 tasks. The generated issue-body
contracts leave optional prompts blank so the user can customize each EPIC or task afterward.

Do not create anything until the user confirms the complete task list and configuration.

## 4. Write the manifest

Create a temporary JSON file outside the repository unless the user requests otherwise:

```json
{
  "repository": "example-org/example-repo",
  "project": {
    "owner": "example-org",
    "number": 12
  },
  "statusField": "AI Task Status",
  "epic": {
    "title": "Convert Objective-C screens to Swift",
    "skill": "objc-to-swift",
    "draftPr": false,
    "skipValidation": false
  },
  "tasks": [
    {
      "title": "Convert LegacyViewController",
      "target": "Sources/LegacyViewController.m"
    },
    {
      "title": "Create a Swift compatibility adapter",
      "target": null
    }
  ]
}
```

Keep task order stable because tasks 1–100 belong to EPIC 1, 101–200 to EPIC 2,
and so on.

For this migration setup skill, the script uses the selected skill name as the EPIC ID and writes
it as the first field in every EPIC's `epic-config`; task branches use it to stay unique and
deterministic. Other EPIC creation flows may use any lowercase slug as the ID and omit `skill`.

## 5. Run the bundled setup script

Locate this skill's directory in the active agent skill root, then run:

```bash
ruby <skill-directory>/scripts/setup_epic.rb /path/to/manifest.json \
  --state /path/to/state.json \
  --result /path/to/result.json \
  --contract-dir .github/octestra/issue-templates
```

The script:

1. Verifies GitHub authentication, Project access, and the auto-add workflow.
2. Creates the `octestra-epic` and migration-skill labels when absent.
3. Resolves the configured organization Issue Field.
4. Creates all required EPICs and adds them to the Project.
5. Creates task issues with bounded parallelism.
6. Links tasks to their EPIC in task order.
7. Initializes successfully linked tasks to `Todo`.

It uses only Ruby's standard library and `gh`. Individual task failures do not stop
remaining tasks and are written to the result JSON. Foundational failures stop
immediately and may occur before a result file can be written.

The state file is updated atomically after each successful operation. Re-run the same
command with the same manifest and state paths to resume; completed EPIC creation,
Project addition, task creation, linking, and status initialization are skipped. If the
manifest changed, the script stops instead of resuming against incompatible state. The
state remains local and is not written into issue bodies.

## 6. Report the result

Read the result JSON and report:

- EPIC URLs and task counts.
- Tasks created, linked, and initialized.
- Every failed task and failure stage.
- The Project URL.
- Whether execution resumed from existing state.

Do not claim success when the script exits nonzero. Keep the manifest and result files
and the state file until failures are resolved; otherwise remove temporary files.

After successful setup, tell the user that tasks can be started by moving their
`AI Task Status` from `Todo` to `Ready`, then to `In Progress`.
