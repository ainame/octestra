import * as core from "@actions/core";
import { GitHubClient } from "./github-client";
import { loadOctestraConfig } from "./shared/config";
import {
  assignOwner,
  assignPullRequestOwner,
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
  defaultBranchTemplate,
  type OperationContext,
} from "./operations";

type LifecycleContextInput = Record<string, unknown>;

function parseLifecycleContext(): LifecycleContextInput {
  const rawValue = core.getInput("lifecycle-context");
  if (!rawValue) {
    return {};
  }
  const parsed: unknown = JSON.parse(rawValue);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("lifecycle-context must be a JSON object");
  }
  return parsed as LifecycleContextInput;
}

function positiveNumber(name: string, rawValue: unknown): number {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requiredNumber(name: string): number {
  return positiveNumber(name, core.getInput(name, { required: true }));
}

function optionalNumber(name: string): number | undefined {
  const rawValue = core.getInput(name);
  if (!rawValue) {
    return undefined;
  }
  return positiveNumber(name, rawValue);
}

function contextString(
  lifecycleContext: LifecycleContextInput,
  inputName: string,
  contextName: string,
  required = false,
): string {
  const inputValue = core.getInput(inputName);
  const contextValue = lifecycleContext[contextName];
  const value = inputValue ||
    (typeof contextValue === "string" ? contextValue : "");
  if (required && !value) {
    throw new Error(`${inputName} is required`);
  }
  return value;
}

function branchTemplate(configTemplate: string): string {
  const rawValue = core.getInput("workflow-context");
  if (!rawValue) {
    return configTemplate || defaultBranchTemplate;
  }
  const parsed: unknown = JSON.parse(rawValue);
  const branch = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).branch
    : undefined;
  if (
    typeof branch !== "object" ||
    branch === null ||
    Array.isArray(branch) ||
    typeof (branch as Record<string, unknown>).template !== "string"
  ) {
    throw new Error("workflow-context must be a JSON object with branch.template");
  }
  return (branch as Record<string, string>).template;
}

export async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const lifecycleContext = parseLifecycleContext();
  const issueInput = core.getInput("issue-number") ||
    lifecycleContext.issue_number;
  const client = new GitHubClient(token);
  const config = await loadOctestraConfig(client, core.getInput("config-ref"));
  const context: OperationContext = {
    client,
    issueNumber: positiveNumber("issue-number", issueInput),
    statusFieldName: contextString(
      lifecycleContext,
      "status-field-name",
      "status_field_name",
    ) || config.status.field_name,
  };

  const operation = core.getInput("operation", { required: true });
  const taskBranchTemplate = branchTemplate(config.branch.task);
  switch (operation) {
    case "validate-transition":
      await validateTransition(
        context,
        contextString(lifecycleContext, "previous-status", "previous_status"),
        contextString(lifecycleContext, "current-status", "current_status"),
        contextString(lifecycleContext, "trigger-actor", "trigger_actor", true),
        contextString(
          lifecycleContext,
          "trigger-actor-type",
          "trigger_actor_type",
          true,
        ),
      );
      break;
    case "finalize-merged-task":
      await finalizeMergedTask(context);
      break;
    case "assign-owner":
      await assignOwner(
        context,
        contextString(lifecycleContext, "trigger-actor", "trigger_actor", true),
        contextString(
          lifecycleContext,
          "trigger-actor-type",
          "trigger_actor_type",
          true,
        ),
      );
      break;
    case "assign-pr-owner":
      await assignPullRequestOwner(context, requiredNumber("pull-number"));
      break;
    case "prepare-task":
      await prepareTask(
        context,
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_in_progress,
        contextString(lifecycleContext, "trigger-actor", "trigger_actor", true),
        contextString(
          lifecycleContext,
          "trigger-actor-type",
          "trigger_actor_type",
          true,
        ),
        taskBranchTemplate,
      );
      break;
    case "build-task-context":
      await buildTaskContext(
        context,
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_in_progress,
        contextString(lifecycleContext, "trigger-actor", "trigger_actor"),
        contextString(
          lifecycleContext,
          "trigger-actor-type",
          "trigger_actor_type",
        ),
        taskBranchTemplate,
      );
      break;
    case "build-validation-context":
      await buildValidationContext(
        context,
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_validation,
        taskBranchTemplate,
      );
      break;
    case "prepare-validation":
      await prepareValidation(
        context,
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_validation,
        taskBranchTemplate,
      );
      break;
    case "update-status":
      await updateStatus(context, core.getInput("next-status", { required: true }));
      break;
    case "resolve-task-pr":
      await resolveTaskPullRequest(
        context,
        core.getInput("branch-name", { required: true }),
      );
      break;
    case "finalize-task":
      await finalizeTask(
        context,
        taskBranchTemplate,
      );
      break;
    case "report-proof":
      await reportProof(
        context,
        core.getInput("proof-path", { required: true }),
        {
          pullNumber: optionalNumber("pull-number"),
        },
      );
      break;
    case "request-review":
      await requestReview(context, requiredNumber("pull-number"));
      break;
    case "finalize-validation":
      await finalizeValidation(
        context,
        requiredNumber("pull-number"),
        core.getInput("proof-path", { required: true }),
      );
      break;
    case "report-failure":
      await reportFailure(context);
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
