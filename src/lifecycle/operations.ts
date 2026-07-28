import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as core from "@actions/core";
import { renderBranchTemplate } from "../shared/branch";
import {
  parseEpicConfig,
  parseTaskConfig,
  type EpicConfig,
} from "../shared/issue-config";
import { markdownTable } from "../shared/markdown";
import { renderPrompt } from "../shared/prompt";
import {
  readProofDocument,
  renderProofComment,
  type ProofDocument,
} from "../shared/proof";
import {
  optionIdOf,
  statusKeyOf,
  type StatusKey,
  type StatusVocabulary,
} from "../shared/status";
import { workflowRunUrl } from "../shared/workflow-run";

// Reporting proof needs no status vocabulary, and the dedicated proof action has
// none to give, so it is a separate narrower context rather than a dummy value.
export interface ProofContext {
  client: OperationsClient;
  issueNumber: number;
}

export interface OperationContext extends ProofContext {
  status: StatusVocabulary;
}

export interface OperationsClient {
  getIssue(issueNumber: number): Promise<{ title: string; body: string }>;
  isClosedByMergedPullRequest(issueNumber: number): Promise<boolean>;
  getParentNumber(issueNumber: number): Promise<number>;
  getUserDisplayName(login: string): Promise<string>;
  branchExists(branchName: string): Promise<boolean>;
  findOpenPullRequest(branchName: string): Promise<number | undefined>;
  assignIssue(issueNumber: number, assignee: string): Promise<void>;
  assignPullRequest(pullNumber: number, assignee: string): Promise<void>;
  getLatestAssignedUser(issueNumber: number): Promise<string | undefined>;
  findLinkedOpenPullRequest(
    issueNumber: number,
    headBranch?: string,
  ): Promise<number | undefined>;
  requestReviewer(pullNumber: number, reviewer: string): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
  getStatus(issueNumber: number, fieldId: number): Promise<number | undefined>;
  statusOptionName(fieldId: number, optionId: number): Promise<string>;
  updateStatus(issueNumber: number, fieldId: number, optionId: number): Promise<void>;
}

interface ActivityReport {
  status: string;
  outcome: string;
  summary: string;
  details?: string;
}

export interface ProofReportOptions {
  pullNumber?: number;
  subjectSha?: string;
}

export const defaultBranchTemplate = "octestra/{epic_id}/issue-{issue_number}";

export function resolveTaskBranchName(
  epicId: string,
  issueNumber: number,
  branchTemplate = defaultBranchTemplate,
): string {
  return renderBranchTemplate(
    branchTemplate,
    { epic_id: epicId, issue_number: String(issueNumber) },
    "branch template must include {epic_id} and {issue_number}",
  );
}

const execFileAsync = promisify(execFile);

// Keyed on config.yml status keys, never on display names: the option ID is the
// identity, and a maintainer renaming an option must not change the graph (P1).
// The empty key is a task entering the graph with no previous status.
const allowedTransitions = new Map<string, Set<StatusKey>>([
  ["", new Set<StatusKey>(["todo"])],
  ["todo", new Set<StatusKey>(["ready"])],
  ["ready", new Set<StatusKey>(["in_progress", "blocked"])],
  ["in_progress", new Set<StatusKey>(["validation", "human_review", "blocked"])],
  ["validation", new Set<StatusKey>(["human_review", "blocked"])],
  ["human_review", new Set<StatusKey>(["done", "blocked"])],
  ["blocked", new Set<StatusKey>(["ready"])],
  ["done", new Set<StatusKey>()],
]);

// The individual update-status operation takes a status from a consumer workflow.
// Accept a config key; names are rejected so nothing new becomes name-keyed (P1).
function requireStatusKey(context: OperationContext, value: string): StatusKey {
  const key = value.trim() as StatusKey;
  if (!context.status.keyToOptionId.has(key)) {
    throw new Error(
      `next-status must be one of the config.yml status keys (${[...context.status.keyToOptionId.keys()].join(", ")}), got ${value}`,
    );
  }
  return key;
}

async function currentStatusKey(context: OperationContext): Promise<StatusKey | undefined> {
  const optionId = await context.client.getStatus(
    context.issueNumber,
    context.status.fieldId,
  );
  return statusKeyOf(context.status, optionId);
}

// The live display name, for comments only. Never compared against.
async function statusLabel(context: OperationContext, key: StatusKey): Promise<string> {
  return context.client.statusOptionName(
    context.status.fieldId,
    optionIdOf(context.status, key),
  );
}

async function applyStatus(context: OperationContext, key: StatusKey): Promise<void> {
  await context.client.updateStatus(
    context.issueNumber,
    context.status.fieldId,
    optionIdOf(context.status, key),
  );
}

async function reportActivity(
  context: OperationContext,
  activity: ActivityReport,
): Promise<void> {
  if (!activity.status || !activity.outcome || !activity.summary) {
    throw new Error("Activity status, outcome, and summary are required");
  }

  const owner = await context.client.getLatestAssignedUser(context.issueNumber);
  const actor = process.env.GITHUB_ACTOR;
  const runUrl = workflowRunUrl();
  const metadata = markdownTable(["Field", "Value"], [
    ["Workflow run", `[View run](${runUrl})`],
    ["Trigger actor", actor ? `@${actor}` : "N/A"],
    ["Task owner", owner ? `@${owner}` : "Unassigned"],
    ["Recorded at", new Date().toISOString()],
  ]);
  const details = activity.details?.trim()
    ? `\n\n### Details\n\n${activity.details.trim()}`
    : "";

  await context.client.comment(
    context.issueNumber,
    [
      "<!-- octestra-activity -->",
      "## Octestra activity",
      "",
      activity.summary.trim(),
      "",
      "| Status | Outcome |",
      "| --- | --- |",
      `| \`${activity.status}\` | \`${activity.outcome}\` |`,
      details,
      "",
      "<details>",
      "<summary>Technical metadata</summary>",
      "",
      metadata,
      "",
      "</details>",
    ].join("\n"),
  );
}

async function reportActivityBestEffort(
  context: OperationContext,
  activity: ActivityReport,
): Promise<void> {
  try {
    await reportActivity(context, activity);
  } catch (error) {
    core.warning(`Failed to report Octestra activity: ${String(error)}`);
  }
}

export async function validateTransition(
  context: OperationContext,
  previousOptionId: number | undefined,
  currentOptionId: number | undefined,
  triggerActor: string,
  triggerActorType: string,
): Promise<boolean> {
  const liveOptionId = await context.client.getStatus(
    context.issueNumber,
    context.status.fieldId,
  );
  // Comparing option IDs, so a rename between the event and this check cannot look
  // like a stale event.
  if (liveOptionId !== currentOptionId) {
    core.setOutput("transition_valid", "false");
    core.warning(
      `Ignoring stale transition event: event=${currentOptionId ?? "(unset)"}, live=${liveOptionId ?? "(unset)"}`,
    );
    return false;
  }

  const previousStatus = statusKeyOf(context.status, previousOptionId) ?? "";
  // An empty key means the status was cleared, which is a real transition the graph
  // rejects. A non-empty option ID that config.yml does not know is a different
  // thing: an option outside the Octestra graph, which is not ours to police.
  const currentStatus = currentOptionId === undefined
    ? ""
    : statusKeyOf(context.status, currentOptionId);
  if (currentStatus === undefined) {
    core.setOutput("transition_valid", "false");
    core.info(
      `Issue #${context.issueNumber} moved to an option that is not an Octestra status; ignoring.`,
    );
    return false;
  }

  const isValid = currentStatus !== "" &&
    (allowedTransitions.get(previousStatus)?.has(currentStatus) ?? false);
  core.setOutput("transition_valid", String(isValid));
  core.setOutput("status_key", currentStatus);
  if (isValid) {
    return true;
  }

  const transition = `${previousStatus || "(unset)"} -> ${currentStatus}`;
  if (triggerActorType === "Bot") {
    core.warning(`Ignoring invalid transition made by a bot: ${transition}`);
    return false;
  }

  await context.client.assignIssue(context.issueNumber, triggerActor);
  await context.client.comment(
    context.issueNumber,
    [
      `@${triggerActor} this AI Task Status transition is not part of the Octestra workflow:`,
      `\`${transition}\`.`,
      "",
      "The status was not changed automatically. Please correct it manually if this transition was unintended.",
    ].join("\n"),
  );
  return false;
}

export async function finalizeMergedTask(context: OperationContext): Promise<void> {
  const currentStatus = await currentStatusKey(context);
  if (currentStatus !== "human_review") {
    core.info(
      `Issue #${context.issueNumber} is ${currentStatus ?? "unset"}, not an Octestra task awaiting review; leaving ${context.status.fieldName} unchanged.`,
    );
    return;
  }

  if (!await context.client.isClosedByMergedPullRequest(context.issueNumber)) {
    core.info(
      `Issue #${context.issueNumber} was not closed by a merged pull request; leaving ${context.status.fieldName} unchanged.`,
    );
    return;
  }

  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await applyStatus(context, "done");
}

async function configureCoauthor(
  client: OperationsClient,
  workspace: string,
  triggerActor: string,
): Promise<void> {
  if (!triggerActor) {
    throw new Error("trigger-actor is required for prepare");
  }

  const displayName = await client.getUserDisplayName(triggerActor);
  const gitDirectory = path.join(workspace, ".git");
  const hooksDirectory = path.join(gitDirectory, "hooks");
  const trailerPath = path.join(gitDirectory, "octestra-coauthor");
  const hookPath = path.join(hooksDirectory, "commit-msg");

  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(
    trailerPath,
    `Co-authored-by: ${displayName} <${triggerActor}@users.noreply.github.com>\n`,
  );
  await writeFile(
    hookPath,
    [
      "#!/bin/sh",
      'git interpret-trailers --in-place --if-exists=replace --trailer "$(cat .git/octestra-coauthor)" "$1"',
      "",
    ].join("\n"),
  );
  await chmod(hookPath, 0o755);
}

export async function buildTaskContext(
  context: OperationContext,
  promptTemplate: string,
  triggerActor: string,
  triggerActorType: string,
  branchTemplate = defaultBranchTemplate,
  checkForExistingWork = false,
): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    throw new Error("GITHUB_WORKSPACE must be set");
  }

  const issue = await context.client.getIssue(context.issueNumber);
  const taskConfig = parseTaskConfig(issue.body);
  const { parentNumber, config } = await loadEpicConfig(context);
  const taskOwner = triggerActorType === "User"
    ? triggerActor
    : await context.client.getLatestAssignedUser(context.issueNumber);
  if (!taskOwner) {
    throw new Error("No assigned task owner found in the issue activity");
  }
  const branchName = resolveTaskBranchName(
    config.id,
    context.issueNumber,
    branchTemplate,
  );
  if (checkForExistingWork) {
    const [branchExists, linkedPullNumber] = await Promise.all([
      context.client.branchExists(branchName),
      context.client.findLinkedOpenPullRequest(context.issueNumber),
    ]);
    if (branchExists || linkedPullNumber) {
      const existingWork = [
        branchExists ? `branch \`${branchName}\`` : undefined,
        linkedPullNumber ? `open PR #${linkedPullNumber}` : undefined,
      ].filter(Boolean).join(" and ");
      await reportActivityBestEffort(context, {
        status: await statusLabel(context, "blocked"),
        outcome: "blocked",
        summary: "Task execution was not started because existing work was found.",
        details: [
          `Found ${existingWork}.`,
          `@${taskOwner} Close the existing PR, if any, and delete its source branch before retrying.`,
          "Then move this task to `Ready`, followed by `In Progress`.",
        ].join("\n\n"),
      });
      await applyStatus(context, "blocked");
      core.setOutput("branch_name", branchName);
      core.setOutput("task_ready", "false");
      return;
    }
  }
  const draftFlag = config.draftPr ? "--draft" : "";
  const prompt = await renderPrompt(path.resolve(workspace, promptTemplate), {
    skillName: config.skillName ?? "",
    target: taskConfig.target,
    epicPrompt: combinePrompts(config.epicPrompt, taskConfig.taskPrompt),
    issueNumber: context.issueNumber,
    pullNumber: undefined,
    draftFlag,
    resultPath: "",
    artifactPath: "",
  });

  await configureCoauthor(context.client, workspace, taskOwner);

  core.setOutput("parent_number", parentNumber);
  core.setOutput("epic_id", config.id);
  core.setOutput("skill_name", config.skillName ?? "");
  core.setOutput(
    "branch_name",
    branchName,
  );
  core.setOutput("task_ready", "true");
  core.setOutput("draft_flag", draftFlag);
  core.setOutput("validation_required", String(config.validationRequired));
  core.setOutput("prompt", prompt);
  core.setOutput("target_file", taskConfig.target ?? "");
  core.setOutput("task_owner", taskOwner);
}

// Aggregate lifecycle preparation used by the boilerplate workflow. Consumers can
// call assignOwner and buildTaskContext separately when they need different sequencing.
export async function prepareTask(
  context: OperationContext,
  promptTemplate: string,
  triggerActor: string,
  triggerActorType: string,
  branchTemplate = defaultBranchTemplate,
): Promise<void> {
  await assignOwner(context, triggerActor, triggerActorType);
  await buildTaskContext(
    context,
    promptTemplate,
    triggerActor,
    triggerActorType,
    branchTemplate,
    true,
  );
}

async function loadEpicConfig(
  context: OperationContext,
): Promise<{ parentNumber: number; config: EpicConfig }> {
  const parentNumber = await context.client.getParentNumber(context.issueNumber);
  const parentIssue = await context.client.getIssue(parentNumber);
  return {
    parentNumber,
    config: parseEpicConfig(parentIssue.body),
  };
}

export async function buildValidationContext(
  context: OperationContext,
  promptTemplate: string,
  branchTemplate = defaultBranchTemplate,
): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    throw new Error("GITHUB_WORKSPACE must be set");
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    throw new Error("RUNNER_TEMP must be set");
  }

  const issue = await context.client.getIssue(context.issueNumber);
  const taskConfig = parseTaskConfig(issue.body);
  const { parentNumber, config } = await loadEpicConfig(context);
  const branchName = resolveTaskBranchName(
    config.id,
    context.issueNumber,
    branchTemplate,
  );
  const pullNumber = await context.client.findLinkedOpenPullRequest(
    context.issueNumber,
    branchName,
  );
  if (!pullNumber) {
    throw new Error("No linked open task PR found in the issue activity");
  }
  const prompt = await renderPrompt(path.resolve(workspace, promptTemplate), {
    skillName: config.skillName ?? "",
    target: taskConfig.target,
    epicPrompt: combinePrompts(
      config.epicPrompt,
      taskConfig.taskPrompt,
      config.validationPrompt,
    ),
    issueNumber: context.issueNumber,
    pullNumber,
    draftFlag: "",
    resultPath: path.join(runnerTemp, "task-validation-result.json"),
    artifactPath: path.join(runnerTemp, "octestra-validation-artifacts"),
  });

  core.setOutput("parent_number", parentNumber);
  core.setOutput("branch_name", branchName);
  core.setOutput("prompt", prompt);
  core.setOutput("pull_number", pullNumber);
  core.setOutput("result_path", path.join(runnerTemp, "task-validation-result.json"));
  core.setOutput("artifact_path", path.join(runnerTemp, "octestra-validation-artifacts"));
  core.setOutput("target_file", taskConfig.target ?? "");
}

// This boundary is intentionally an aggregate even though preparation is currently
// one operation, leaving room for framework-owned setup without expanding workflows.
export async function prepareValidation(
  context: OperationContext,
  promptTemplate: string,
  branchTemplate = defaultBranchTemplate,
): Promise<void> {
  await buildValidationContext(context, promptTemplate, branchTemplate);
}

function combinePrompts(...prompts: string[]): string {
  return prompts.map((prompt) => prompt.trim()).filter(Boolean).join("\n\n");
}

export async function updateStatus(
  context: OperationContext,
  nextStatus: string,
): Promise<void> {
  if (!nextStatus) {
    throw new Error("next-status is required for update-status");
  }
  await applyStatus(context, requireStatusKey(context, nextStatus));
}

export async function assignOwner(
  context: OperationContext,
  triggerActor: string,
  triggerActorType: string,
): Promise<void> {
  if (!triggerActor) {
    throw new Error("trigger-actor is required for assign-owner");
  }
  if (triggerActorType !== "User") {
    core.info(`Keeping the existing task owner for ${triggerActorType} actor ${triggerActor}`);
    return;
  }
  await context.client.assignIssue(context.issueNumber, triggerActor);
}

export async function requestReview(
  context: OperationContext,
  pullNumber: number,
): Promise<string> {
  const reviewer = await assignPullRequestOwner(context, pullNumber);
  await context.client.requestReviewer(pullNumber, reviewer);
  core.setOutput("reviewer", reviewer);
  return reviewer;
}

export async function assignPullRequestOwner(
  context: OperationContext,
  pullNumber: number,
): Promise<string> {
  const taskOwner = await context.client.getLatestAssignedUser(context.issueNumber);
  if (!taskOwner) {
    throw new Error("No assigned task owner found in the issue activity");
  }
  await context.client.assignPullRequest(pullNumber, taskOwner);
  core.setOutput("task_owner", taskOwner);
  return taskOwner;
}

export async function reportProof(
  context: ProofContext,
  proofPath: string,
  options: ProofReportOptions = {},
): Promise<ProofDocument> {
  if (!proofPath) {
    throw new Error("proof-path is required for report-proof");
  }

  const proof = await readProofDocument(proofPath);
  const owner = await context.client.getLatestAssignedUser(context.issueNumber);
  const subjectSha = options.subjectSha ?? await currentCommitSha();
  const comment = renderProofComment(proof, {
    issueNumber: context.issueNumber,
    pullNumber: options.pullNumber,
    subjectSha,
    owner,
    actor: process.env.GITHUB_ACTOR,
    runUrl: workflowRunUrl(),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  await context.client.comment(context.issueNumber, comment);
  core.setOutput("outcome", proof.outcome);
  core.setOutput("summary", proof.summary);
  return proof;
}

async function currentCommitSha(): Promise<string | undefined> {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
    });
    return stdout.trim() || undefined;
  } catch (error) {
    core.warning(`Could not determine proof subject SHA: ${String(error)}`);
    return undefined;
  }
}

export async function resolveTaskPullRequest(
  context: OperationContext,
  branchName: string,
): Promise<number> {
  if (!branchName) {
    throw new Error("branch-name is required for resolve-task-pr");
  }
  const pullNumber = await context.client.findOpenPullRequest(branchName);
  if (!pullNumber) {
    throw new Error(`PR not found for branch ${branchName}`);
  }
  core.setOutput("pull_number", pullNumber);
  return pullNumber;
}

export async function finalizeTask(
  context: OperationContext,
  branchTemplate = defaultBranchTemplate,
): Promise<void> {
  const { config } = await loadEpicConfig(context);
  const branchName = resolveTaskBranchName(
    config.id,
    context.issueNumber,
    branchTemplate,
  );
  const failureStatus: StatusKey = "blocked";

  if (!(await context.client.branchExists(branchName))) {
    core.warning("Task branch was not found. Issue left open for manual review.");
    await reportActivity(context, {
      status: await statusLabel(context, failureStatus),
      outcome: "blocked",
      summary: "The task agent did not create the expected branch.",
      details: `- Expected branch: \`${branchName}\`\n- Move the task to \`Ready\` after resolving the blocker to retry.`,
    });
    // Updating status can trigger the next workflow, so all Octestra work must finish first.
    await applyStatus(context, failureStatus);
    return;
  }

  const nextStatus: StatusKey = config.validationRequired ? "validation" : "human_review";
  const pullNumber = await resolveTaskPullRequest(context, branchName);
  const reviewer = nextStatus === "human_review"
    ? await requestReview(context, pullNumber)
    : undefined;
  const taskOwner = reviewer ??
    await assignPullRequestOwner(context, pullNumber);

  const nextStatusLabel = await statusLabel(context, nextStatus);
  await reportActivityBestEffort(context, {
    status: nextStatusLabel,
    outcome: "succeeded",
    summary: reviewer
      ? `Created task PR #${pullNumber} and requested review from @${reviewer}.`
      : `Created task PR #${pullNumber} and queued validation.`,
    details: [
      `- Pull request: #${pullNumber}`,
      `- Pull request assigned to @${taskOwner}`,
      reviewer ? `- Reviewer: @${reviewer}` : undefined,
      `- ${context.status.fieldName} updated to \`${nextStatusLabel}\``,
    ].filter(Boolean).join("\n"),
  });
  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await applyStatus(context, nextStatus);
}

// Aggregate lifecycle exit point for the default validation policy. Repositories
// with different policy can compose reportProof, requestReview, and updateStatus.
export async function finalizeValidation(
  context: OperationContext,
  pullNumber: number,
  proofPath: string,
): Promise<void> {
  const proof = await reportProof(context, proofPath, {
    pullNumber,
  });
  if (proof.outcome !== "passed") {
    // Updating status can trigger the next workflow, so all Octestra work must finish first.
    await applyStatus(context, "blocked");
    return;
  }

  await requestReview(context, pullNumber);
  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await applyStatus(context, "human_review");
}

export async function reportFailure(
  context: OperationContext,
): Promise<void> {
  const failureStatus: StatusKey = "blocked";
  const runUrl = workflowRunUrl();

  try {
    await reportActivity(context, {
      status: await statusLabel(context, failureStatus),
      outcome: "failed",
      summary: "The task workflow failed or was cancelled.",
      details: `- Failed workflow run: ${runUrl}\n- Move the task to \`Ready\` after resolving the blocker to retry.`,
    });
  } catch (error) {
    core.warning(`Failed to post the task failure report: ${String(error)}`);
  }

  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await applyStatus(context, failureStatus);
}
