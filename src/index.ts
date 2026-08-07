import * as core from "@actions/core";
import { loadOctestraConfig } from "./shared/config";
import { GitHubClient } from "./shared/github-client";
import { positiveInteger } from "./shared/validate";
import {
  assignOwner,
  buildTaskContext,
  buildValidationContext,
  finalizeMergedTask,
  finalizeTask,
  finalizeValidation,
  prepareTask,
  prepareValidation,
  reportFailure,
  reportProof,
  resolveTaskPullRequest,
  requestReview,
  updateStatus,
  validateTransition,
  type OperationContext,
} from "./lifecycle/operations";

function requiredNumber(name: string): number {
  return positiveInteger(name, core.getInput(name, { required: true }));
}

function optionalNumber(name: string): number | undefined {
  const rawValue = core.getInput(name);
  if (!rawValue) {
    return undefined;
  }
  return positiveInteger(name, rawValue);
}

// Every lifecycle operation that cares who triggered it needs the pair, and both
// halves are required together.
function triggerActorPair(required: boolean): [string, string] {
  return [
    core.getInput("trigger-actor", { required }),
    core.getInput("trigger-actor-type", { required }),
  ];
}

export async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const operation = core.getInput("operation", { required: true });
  const client = new GitHubClient(token);
  const config = await loadOctestraConfig(client, core.getInput("config-ref"));
  function lifecycleOperationContext(): OperationContext {
    const statusFieldName = core.getInput("status-field-name");
    const statusFieldId = core.getInput("status-field-id");
    if (statusFieldName || statusFieldId) {
      if (!statusFieldName || !statusFieldId) {
        throw new Error("status-field-name and status-field-id must be provided together");
      }
      return {
        client,
        issueNumber: requiredNumber("issue-number"),
        statusFieldId: positiveInteger("status-field-id", statusFieldId),
      };
    }
    return {
      client,
      issueNumber: requiredNumber("issue-number"),
      statusFieldId: config.status.field_id,
    };
  }

  switch (operation) {
    case "lifecycle/validate-transition":
      await validateTransition(
        lifecycleOperationContext(),
        core.getInput("previous-status"),
        core.getInput("current-status"),
        ...triggerActorPair(true),
      );
      break;
    case "lifecycle/finalize-merged-task":
      await finalizeMergedTask(lifecycleOperationContext());
      break;
    case "assign-owner":
      await assignOwner(
        lifecycleOperationContext(),
        ...triggerActorPair(true),
      );
      break;
    case "lifecycle/prepare-task":
      await prepareTask(
        lifecycleOperationContext(),
        config.prompts.lifecycle_in_progress,
        ...triggerActorPair(true),
        config.branch.task,
      );
      break;
    case "lifecycle/build-task-context":
      await buildTaskContext(
        lifecycleOperationContext(),
        config.prompts.lifecycle_in_progress,
        ...triggerActorPair(false),
        config.branch.task,
      );
      break;
    case "lifecycle/build-validation-context":
      await buildValidationContext(
        lifecycleOperationContext(),
        config.prompts.lifecycle_validation,
        config.branch.task,
      );
      break;
    case "lifecycle/prepare-validation":
      await prepareValidation(
        lifecycleOperationContext(),
        config.prompts.lifecycle_validation,
        config.branch.task,
      );
      break;
    case "update-status":
      await updateStatus(lifecycleOperationContext(), core.getInput("next-status", { required: true }));
      break;
    case "resolve-task-pr":
      await resolveTaskPullRequest(
        lifecycleOperationContext(),
        core.getInput("branch-name", { required: true }),
      );
      break;
    case "lifecycle/finalize-task":
      await finalizeTask(lifecycleOperationContext(), config.branch.task);
      break;
    case "report-proof":
      await reportProof(
        lifecycleOperationContext(),
        core.getInput("proof-path", { required: true }),
        {
          pullNumber: optionalNumber("pull-number"),
        },
      );
      break;
    case "request-review":
      await requestReview(lifecycleOperationContext(), requiredNumber("pull-number"));
      break;
    case "lifecycle/finalize-validation":
      await finalizeValidation(
        lifecycleOperationContext(),
        requiredNumber("pull-number"),
        core.getInput("proof-path", { required: true }),
      );
      break;
    case "lifecycle/report-failure":
      await reportFailure(lifecycleOperationContext());
      break;
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
