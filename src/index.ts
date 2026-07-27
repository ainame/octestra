import * as core from "@actions/core";
import { GitHubClient } from "./shared/github-client";
import { loadOctestraConfig } from "./shared/config";
import { finalizeRun, loopDefinition, parseLoopContext, parseLoopSelection, prepareRun, reportFailure as reportLoopFailure, selectTasks } from "./loop/operations";
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
} from "./lifecycle/operations";

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
  const requestedOperation = core.getInput("operation", { required: true });
  const aliases: Record<string, string> = { "validate-transition": "lifecycle/validate-transition", "finalize-merged-task": "lifecycle/finalize-merged-task", "prepare-task": "lifecycle/prepare-task", "finalize-task": "lifecycle/finalize-task", "prepare-validation": "lifecycle/prepare-validation", "finalize-validation": "lifecycle/finalize-validation", "build-task-context": "lifecycle/build-task-context", "build-validation-context": "lifecycle/build-validation-context", "report-failure": "lifecycle/report-failure" };
  const operation = aliases[requestedOperation] ?? requestedOperation;
  if (operation !== requestedOperation) core.warning(`${requestedOperation} is deprecated; use ${operation}`);
  const client = new GitHubClient(token);
  const config = await loadOctestraConfig(client, core.getInput("config-ref"));
  function lifecycleOperationContext(): OperationContext {
    const issueInput = core.getInput("issue-number") || lifecycleContext.issue_number;
    return { client, issueNumber: positiveNumber("issue-number", issueInput), statusFieldName: contextString(lifecycleContext, "status-field-name", "status_field_name") || config.status.field_name };
  }
  const taskBranchTemplate = branchTemplate(config.branch.task);

  switch (operation) {
    case "loop/select-tasks": {
      const loop = parseLoopContext(core.getInput("loop-context", { required: true }));
      await selectTasks(client, loopDefinition(config, loop), config.status.field_name);
      break;
    }
    case "loop/prepare-run": {
      const loop = parseLoopContext(core.getInput("loop-context", { required: true }));
      const issuesInput = core.getInput("loop-issues");
      await prepareRun(loop, loopDefinition(config, loop), {
        issueNumber: optionalNumber("issue-number"),
        issues: issuesInput ? parseLoopSelection(issuesInput) : undefined,
        runNumber: process.env.GITHUB_RUN_NUMBER ?? "",
        branchTemplate: config.branch.loop,
      });
      break;
    }
    case "loop/finalize-run": {
      const loop = parseLoopContext(core.getInput("loop-context", { required: true }));
      await finalizeRun(client, loopDefinition(config, loop), config.status.field_name, core.getInput("proof-path", { required: true }), loop.dry_run, optionalNumber("issue-number"));
      break;
    }
    case "loop/report-failure": {
      const loop = parseLoopContext(core.getInput("loop-context", { required: true }));
      await reportLoopFailure(client, loop, loopDefinition(config, loop));
      break;
    }
    case "lifecycle/validate-transition":
      await validateTransition(
        lifecycleOperationContext(),
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
    case "lifecycle/finalize-merged-task":
      await finalizeMergedTask(lifecycleOperationContext());
      break;
    case "assign-owner":
      await assignOwner(
        lifecycleOperationContext(),
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
      await assignPullRequestOwner(lifecycleOperationContext(), requiredNumber("pull-number"));
      break;
    case "lifecycle/prepare-task":
      await prepareTask(
        lifecycleOperationContext(),
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
    case "lifecycle/build-task-context":
      await buildTaskContext(
        lifecycleOperationContext(),
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
    case "lifecycle/build-validation-context":
      await buildValidationContext(
        lifecycleOperationContext(),
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_validation,
        taskBranchTemplate,
      );
      break;
    case "lifecycle/prepare-validation":
      await prepareValidation(
        lifecycleOperationContext(),
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_validation,
        taskBranchTemplate,
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
      await finalizeTask(
        lifecycleOperationContext(),
        taskBranchTemplate,
      );
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
