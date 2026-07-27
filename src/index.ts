import * as core from "@actions/core";
import { GitHubClient } from "./shared/github-client";
import { loadOctestraConfig } from "./shared/config";
import { parseLoopContext, selectTasks, finalizeRun } from "./loop/operations";
import { renderPrompt } from "./shared/prompt";
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
  const issueInput = core.getInput("issue-number") || lifecycleContext.issue_number;
  const context: OperationContext = { client, issueNumber: operation.startsWith("loop/") && !issueInput ? 0 : positiveNumber("issue-number", issueInput), statusFieldName: contextString(lifecycleContext, "status-field-name", "status_field_name") || config.status.field_name };
  const taskBranchTemplate = branchTemplate(config.branch.task);
  switch (operation) {
    case "loop/select-tasks": { const loop = parseLoopContext(core.getInput("loop-context", { required: true })); const definition = config.loops[loop.loop_id]; if (!definition) throw new Error(`Unknown loop: ${loop.loop_id}`); await selectTasks(client, definition); break; }
    case "loop/prepare-run": { const loop = parseLoopContext(core.getInput("loop-context", { required: true })); const definition = config.loops[loop.loop_id]; if (!definition) throw new Error(`Unknown loop: ${loop.loop_id}`); const issue = requiredNumber("issue-number"); core.setOutput("result_path", `octestra-loop-${loop.loop_id}-${issue}.json`); core.setOutput("artifact_path", `octestra-loop-${loop.loop_id}-${issue}-artifacts`); core.setOutput("prompt", await renderPrompt(definition.prompt, { skillName: "", epicPrompt: "", issueNumber: issue, pullNumber: undefined, draftFlag: "", resultPath: `octestra-loop-${loop.loop_id}-${issue}.json`, artifactPath: `octestra-loop-${loop.loop_id}-${issue}-artifacts` })); break; }
    case "loop/finalize-run": { const loop = parseLoopContext(core.getInput("loop-context", { required: true })); const definition = config.loops[loop.loop_id]; if (!definition) throw new Error(`Unknown loop: ${loop.loop_id}`); await finalizeRun(client, requiredNumber("issue-number"), definition, core.getInput("proof-path", { required: true }), loop.dry_run); break; }
    case "loop/report-failure": { const loop = parseLoopContext(core.getInput("loop-context", { required: true })); const definition = config.loops[loop.loop_id]; if (definition?.report_issue) await client.comment(definition.report_issue, `Octestra loop ${loop.loop_id} failed: ${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`); break; }
    case "lifecycle/validate-transition":
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
    case "lifecycle/finalize-merged-task":
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
    case "lifecycle/prepare-task":
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
    case "lifecycle/build-task-context":
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
    case "lifecycle/build-validation-context":
      await buildValidationContext(
        context,
        core.getInput("prompt-template") ||
          config.prompts.lifecycle_validation,
        taskBranchTemplate,
      );
      break;
    case "lifecycle/prepare-validation":
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
    case "lifecycle/finalize-task":
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
    case "lifecycle/finalize-validation":
      await finalizeValidation(
        context,
        requiredNumber("pull-number"),
        core.getInput("proof-path", { required: true }),
      );
      break;
    case "lifecycle/report-failure":
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
