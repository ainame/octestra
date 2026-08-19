---
name: octestra
description: >
  Follow the framework workflow contract for an Octestra task, triage, or validation phase.
---

# Follow the Octestra workflow contract

Every Octestra agent prompt names one phase: `task`, `triage`, or `validation`. Follow only that
phase contract. Repository skills named by the prompt own domain policy; this skill owns the
workflow protocol around that policy.

## Task phase

1. Use the repository task skill when the prompt names one.
2. Work only on the requested task and create the exact branch named by the prompt.
3. Commit the implementation, push that branch, and create the pull request as instructed.
4. Include the task-closing line supplied by the prompt in the pull request description.

The task phase is a side-effect contract. Do not write a task result JSON file. Octestra verifies
the expected branch and pull request after the agent exits.

## Triage phase

Use the repository triage skill named by the prompt to inspect the current EPIC's Todo tasks and
decide which are ready. The repository skill owns discovery, selection limits, ordering, and domain
readiness policy, including any issue preparation or other repository-owned issue mutations that
policy requires.

You may update issue bodies and other issue data as the repository skill requires. Do not change
the `AI Task Status` Issue Field or its status option directly. Octestra validates the selected
tasks and exclusively performs the allowed `Todo` to `Ready` status changes after the agent exits.
Include a task in `readyIssues` only after every required preparation step succeeded and the
repository skill considers that task ready.

Write this JSON object to the exact result path from the prompt:

```json
{
  "kind": "triage-result",
  "readyIssues": [1, 2, 3],
  "summary": "Optional summary"
}
```

`readyIssues` must contain unique, positive repository issue numbers. Use an empty array when no
task is ready. Do not call these values IDs. `summary` is optional.

After writing the file, run:

```sh
<skill-directory>/scripts/check.sh triage "<result-path>"
```

## Validation phase

Use the repository validation skill named by the prompt to validate the already checked-out pull
request head. Do not modify files, create commits, switch branches, or push.

Write this JSON object to the exact result path from the prompt:

```json
{
  "kind": "validation-result",
  "outcome": "passed",
  "summary": "Summary of the validation result"
}
```

Use `passed` only when every required check completed successfully. Use `failed` when a check
failed, a problem was found, or a required check could not be completed.

Add any of these optional fields when useful:

- `checks`: an array of objects with non-empty `name` and `result` strings.
- `acceptance`: an array of acceptance-criterion result objects.
- `evidence`: an array of evidence objects.
- `artifacts`: an array of artifact objects.
- `knownGaps`: an array of strings.
- `details`: non-empty Markdown describing commands run and findings.

Do not invent acceptance criteria. Preserve failed, skipped, and blocked checks rather than
omitting them or reporting success.

After writing the file, run:

```sh
<skill-directory>/scripts/check.sh validation "<result-path>"
```

If a checker reports an error, correct the JSON and run it again. Never change a truthful decision
or validation outcome merely to satisfy the checker.
