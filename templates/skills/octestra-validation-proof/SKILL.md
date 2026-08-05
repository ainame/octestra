---
name: octestra-validation-proof
description: >
  Write and validate the result JSON required after an Octestra validation run.
---

# Record Octestra validation proof

Use this skill after completing the requested validation. The prompt supplies the exact result path.

Write a JSON object to that path with these required fields:

```json
{
  "outcome": "passed or failed",
  "summary": "Summary of the validation result"
}
```

Use `passed` only when every required check completed successfully. Use `failed` when a check
failed, a problem was found, or a required check could not be completed.

Add any of these optional fields when they make the result more useful:

- `checks`: an array of objects. Every object must have non-empty `name` and `result` strings.
- `acceptance`: an array of acceptance-criterion result objects.
- `evidence`: an array of evidence objects.
- `knownGaps`: an array of strings.
- `details`: non-empty Markdown describing commands run and findings.

Do not invent acceptance criteria. Preserve failed, skipped, and blocked checks rather than
omitting them or reporting success.

After writing the file, run:

```sh
<skill-directory>/scripts/check.sh "<result-path>"
```

If the command reports an error, correct the JSON and run it again. Do not change a truthful
validation outcome merely to satisfy the checker.
