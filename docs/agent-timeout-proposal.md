# Configurable agent timeouts (proposal)

Tracks [issue #32](https://github.com/ainame/octestra/issues/32). This is a design
proposal for later implementation; the settings below are not implemented.

## Problem

Consumers own the task, validation and triage composite actions, but timeout
configuration belongs to their calling workflow. Editing the framework-owned
lifecycle workflow loses that customization on update. All three shipped agent
jobs currently have a 60-minute timeout.

## Proposed wiring

Add optional per-phase settings to the default-branch configuration:

```yaml
agent_timeout_minutes:
  task: 45
  validation: 30
  triage: 20
```

These values illustrate the shape, not agreed defaults. Preparation operations
would publish a validated `agent_timeout_minutes` output. The calling workflow
would apply it to the step invoking the consumer's composite action:

```yaml
- name: Run task agent
  if: steps.epic.outputs.task_ready == 'true'
  uses: ./.github/octestra/actions/task-agent
  timeout-minutes: ${{ fromJSON(steps.epic.outputs.agent_timeout_minutes) }}
```

The timeout covers consumer setup and execution together. Keep preparation,
execution and finalization on the same runner. No composite-action input or new
mirrored repository variable is needed.

## Decisions and constraints before implementation

- Choose defaults and preserve defined behavior when the section or individual
  phase keys are absent: installed configuration files survive updates.
- Validate explicit values as positive integers within GitHub's step limit of
  360 minutes. Reject booleans, nulls and fractions rather than coercing them.
- Decide the whole-job budget separately. The existing 60-minute job cap would
  otherwise override longer agent budgets. Prefer publishing job budgets from
  the existing lifecycle guard and loop discovery jobs, then consuming `needs`
  outputs at job level. Do not add a preparation job just to read configuration.
- Decide whether job overhead is fixed or configurable, including how the maximum
  agent timeout fits within the runner's job limit. Overhead is a shared allowance
  for preparation and finalization, not a guarantee that finalization will run.
- Keep job and step budgets consistent if default-branch configuration changes
  between guard/discovery and preparation. Carry a single resolved budget forward
  or pin subsequent configuration reads to the same revision.
- Verify timeout behavior for a composite invocation in real Actions, including
  child processes and the lifecycle failure reporter. Do not finalize a partial
  validation or triage result after timeout. Whole-job cancellation may prevent
  in-job cleanup; do not promise cleanup based on a larger timeout alone.
- Existing loop workflows are consumer-owned and preserved on update. Document
  the one-time wiring change; do not replace these workflows automatically.
- Longer execution also needs a credential-lifetime review: changing a timeout
  does not extend the App token created before the agent runs.

## Implementation handoff

Update `src/shared/config.ts`, lifecycle and loop operation outputs, `action.yml`,
workflow templates and the config template. Cover absent keys, invalid values,
successful output propagation, job/step budget consistency and preserved loop
installations. Check whether the installed maintenance CLI needs matching validation.
Document migration and timeout scope, then run `make all` and commit the rebuilt
bundle with source changes. Exercise a short timeout using `workflow_dispatch`
in a consumer test repository before claiming end-to-end verification.

## References

- [Workflow timeout syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Expression contexts for step and job timeouts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
- [Composite action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
