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
import {
  finalizeTriage,
  listEpics,
  prepareTriage,
} from "./loop/operations";

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
    core.getInput("trigger_actor", { required }),
    core.getInput("trigger_actor_type", { required }),
  ];
}

export async function run(): Promise<void> {
  const operation = core.getInput("operation", { required: true });
  const token = core.getInput("github_token", { required: true });
  const client = new GitHubClient(token);
  if (operation === "loop/list-epics") {
    await listEpics(client);
    return;
  }
  if (operation === "loop/prepare-triage") {
    const config = await loadOctestraConfig(
      client,
      core.getInput("config_ref"),
    );
    await prepareTriage(
      {
        client,
        epicNumber: requiredNumber("issue_number"),
      },
      config.prompts.loop_todo,
    );
    return;
  }

  const config = await loadOctestraConfig(client, core.getInput("config_ref"));
  if (operation === "loop/finalize-triage") {
    await finalizeTriage(
      {
        client,
        epicNumber: requiredNumber("issue_number"),
        statusFieldId: config.status.field_id,
      },
      core.getInput("result_path", { required: true }),
    );
    return;
  }
  function lifecycleOperationContext(): OperationContext {
    const statusFieldName = core.getInput("status_field_name");
    const statusFieldId = core.getInput("status_field_id");
    if (statusFieldName || statusFieldId) {
      if (!statusFieldName || !statusFieldId) {
        throw new Error("status_field_name and status_field_id must be provided together");
      }
      return {
        client,
        issueNumber: requiredNumber("issue_number"),
        statusFieldId: positiveInteger("status_field_id", statusFieldId),
      };
    }
    return {
      client,
      issueNumber: requiredNumber("issue_number"),
      statusFieldId: config.status.field_id,
    };
  }

  switch (operation) {
    case "lifecycle/validate-transition":
      await validateTransition(
        lifecycleOperationContext(),
        core.getInput("previous_status"),
        core.getInput("current_status"),
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
      await updateStatus(
        lifecycleOperationContext(),
        core.getInput("next_status", { required: true }),
      );
      break;
    case "resolve-task-pr":
      await resolveTaskPullRequest(
        lifecycleOperationContext(),
        core.getInput("branch_name", { required: true }),
      );
      break;
    case "lifecycle/finalize-task": {
      const branchName = core.getInput("branch_name");
      const skipValidation = core.getInput("skip_validation");
      if (Boolean(branchName) !== Boolean(skipValidation)) {
        throw new Error(
          "branch_name and skip_validation must be provided together for lifecycle/finalize-task",
        );
      }
      await finalizeTask(
        lifecycleOperationContext(),
        branchName || undefined,
        skipValidation
          ? core.getBooleanInput("skip_validation")
          : undefined,
        config.branch.task,
      );
      break;
    }
    case "report-proof":
      await reportProof(
        lifecycleOperationContext(),
        core.getInput("result_path") ||
          core.getInput("proof_path", { required: true }),
        {
          pullNumber: optionalNumber("pull_number"),
        },
      );
      break;
    case "request-review":
      await requestReview(lifecycleOperationContext(), requiredNumber("pull_number"));
      break;
    case "lifecycle/finalize-validation":
      await finalizeValidation(
        lifecycleOperationContext(),
        requiredNumber("pull_number"),
        core.getInput("result_path") ||
          core.getInput("proof_path", { required: true }),
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
