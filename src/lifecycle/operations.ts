import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as core from "@actions/core";
import { normalizeAgentDebugFlag } from "../shared/operations";
import {
  reportActivity,
  reportActivityBestEffort,
} from "../shared/activity";
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
import { workflowRunUrl } from "../shared/workflow-run";

// Reporting proof needs no status field, so it takes a narrower context than the
// operations that move a task through the state graph.
export interface ProofContext {
  client: OperationsClient;
  issueNumber: number;
}

export interface OperationContext extends ProofContext {
  statusFieldId: number;
}

export interface OperationsClient {
  getIssue(issueNumber: number): Promise<{ title: string; body: string }>;
  isClosedByMergedPullRequest(issueNumber: number): Promise<boolean>;
  getParentNumber(issueNumber: number): Promise<number>;
  getUserDisplayName(login: string): Promise<string>;
  branchExists(branchName: string): Promise<boolean>;
  findOpenPullRequest(branchName: string): Promise<number | undefined>;
  assignIssue(issueNumber: number, assignee: string): Promise<void>;
  getLatestAssignedUser(issueNumber: number): Promise<string | undefined>;
  findLinkedOpenPullRequest(
    issueNumber: number,
    headBranch?: string,
  ): Promise<number | undefined>;
  markPullRequestReadyForReview(pullNumber: number): Promise<void>;
  requestReviewer(pullNumber: number, reviewer: string): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
  getStatus(issueNumber: number, fieldId: number): Promise<string | undefined>;
  updateStatus(issueNumber: number, fieldId: number, status: string): Promise<void>;
}

export interface ProofReportOptions {
  pullNumber?: number;
  subjectSha?: string;
  // Rendered as a "Next steps" section, only when the proof outcome is not `passed`.
  failureGuidance?: string;
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

// Human Review and Blocked may re-enter Validation: it re-runs validation against the task's
// existing open pull request without discarding the work. Re-entering In Progress is deliberately
// not allowed — the only task re-run is the destructive one through Ready (D20).
const allowedTransitions = new Map<string, Set<string>>([
  ["", new Set(["Todo"])],
  ["Todo", new Set(["Ready"])],
  ["Ready", new Set(["In Progress", "Blocked"])],
  ["In Progress", new Set(["Validation", "Human Review", "Blocked"])],
  ["Validation", new Set(["Human Review", "Blocked"])],
  ["Human Review", new Set(["Done", "Blocked", "Validation"])],
  ["Blocked", new Set(["Ready", "Validation"])],
  ["Done", new Set()],
]);

export async function validateTransition(
  context: OperationContext,
  previousStatus: string,
  currentStatus: string,
  triggerActor: string,
  triggerActorType: string,
): Promise<boolean> {
  const liveStatus = await context.client.getStatus(
    context.issueNumber,
    context.statusFieldId,
  );
  if ((liveStatus ?? "") !== currentStatus) {
    core.setOutput("transition_valid", "false");
    core.warning(
      `Ignoring stale transition event: event=${currentStatus || "(unset)"}, live=${liveStatus || "(unset)"}`,
    );
    return false;
  }

  const isValid = allowedTransitions.get(previousStatus)?.has(currentStatus) ?? false;
  core.setOutput("transition_valid", String(isValid));
  core.setOutput("status_key", currentStatus.toLowerCase().replaceAll(" ", "_"));
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
  const currentStatus = await context.client.getStatus(
    context.issueNumber,
    context.statusFieldId,
  );
  if (currentStatus !== "Human Review") {
    core.info(
      `Issue #${context.issueNumber} is ${currentStatus ?? "unset"}, not an Octestra task awaiting review; leaving AI Task Status unchanged.`,
    );
    return;
  }

  if (!await context.client.isClosedByMergedPullRequest(context.issueNumber)) {
    core.info(
      `Issue #${context.issueNumber} was not closed by a merged pull request; leaving AI Task Status unchanged.`,
    );
    return;
  }

  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await context.client.updateStatus(
    context.issueNumber,
    context.statusFieldId,
    "Done",
  );
}

async function configureCoauthor(
  client: OperationsClient,
  workspace: string,
  triggerActor: string,
): Promise<void> {
  if (!triggerActor) {
    throw new Error("trigger_actor is required for prepare");
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
): Promise<boolean> {
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
        status: "Blocked",
        outcome: "blocked",
        summary: "Task execution was not started because existing work was found.",
        details: [
          `Found ${existingWork}.`,
          linkedPullNumber
            ? "To validate the existing pull request instead of restarting, move this task to `Validation`."
            : undefined,
          `@${taskOwner} Close the existing PR, if any, and delete its source branch before retrying.`,
          "Then move this task to `Ready`, followed by `In Progress`.",
        ].filter(Boolean).join("\n\n"),
      });
      await context.client.updateStatus(
        context.issueNumber,
        context.statusFieldId,
        "Blocked",
      );
      core.setOutput("branch_name", branchName);
      core.setOutput("task_ready", "false");
      return false;
    }
  }
  const draftFlag = config.draftPr ? "--draft" : "";
  const prompt = await renderPrompt(path.resolve(workspace, promptTemplate), {
    taskSkill: config.taskSkill ?? "",
    validationSkill: config.validationSkill ?? "",
    target: taskConfig.target,
    epicTaskPrompt: config.epicTaskPrompt,
    taskPrompt: taskConfig.taskPrompt,
    epicValidationPrompt: config.epicValidationPrompt,
    validationPrompt: taskConfig.validationPrompt,
    issueNumber: context.issueNumber,
    pullNumber: undefined,
    branchName,
    draftFlag,
    resultPath: "",
    artifactPath: "",
  });

  await configureCoauthor(context.client, workspace, taskOwner);

  core.setOutput("parent_number", parentNumber);
  core.setOutput("epic_id", config.id);
  core.setOutput("task_skill", config.taskSkill ?? "");
  core.setOutput(
    "branch_name",
    branchName,
  );
  core.setOutput("task_ready", "true");
  core.setOutput("draft_flag", draftFlag);
  core.setOutput("skip_validation", String(config.skipValidation));
  core.setOutput("prompt", prompt);
  core.setOutput("target", taskConfig.target ?? "");
  core.setOutput("task_owner", taskOwner);
  return true;
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
  const taskReady = await buildTaskContext(
    context,
    promptTemplate,
    triggerActor,
    triggerActorType,
    branchTemplate,
    true,
  );
  if (taskReady) {
    normalizeAgentDebugFlag(process.env.OCTESTRA_AGENT_DEBUG_VALUE ?? "");
  }
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
    taskSkill: config.taskSkill ?? "",
    validationSkill: config.validationSkill ?? "",
    target: taskConfig.target,
    epicTaskPrompt: config.epicTaskPrompt,
    taskPrompt: taskConfig.taskPrompt,
    epicValidationPrompt: config.epicValidationPrompt,
    validationPrompt: taskConfig.validationPrompt,
    issueNumber: context.issueNumber,
    pullNumber,
    branchName,
    draftFlag: "",
    resultPath: path.join(runnerTemp, "task-validation-result.json"),
    artifactPath: path.join(runnerTemp, "octestra-validation-artifacts"),
  });

  core.setOutput("parent_number", parentNumber);
  core.setOutput("validation_skill", config.validationSkill ?? "");
  core.setOutput("branch_name", branchName);
  core.setOutput("prompt", prompt);
  core.setOutput("pull_number", pullNumber);
  core.setOutput("result_path", path.join(runnerTemp, "task-validation-result.json"));
  core.setOutput("artifact_path", path.join(runnerTemp, "octestra-validation-artifacts"));
  core.setOutput("target", taskConfig.target ?? "");
}

// This boundary is intentionally an aggregate even though preparation is currently
// one operation, leaving room for framework-owned setup without expanding workflows.
export async function prepareValidation(
  context: OperationContext,
  promptTemplate: string,
  branchTemplate = defaultBranchTemplate,
): Promise<void> {
  await buildValidationContext(context, promptTemplate, branchTemplate);
  normalizeAgentDebugFlag(process.env.OCTESTRA_AGENT_DEBUG_VALUE ?? "");
}

export async function updateStatus(
  context: OperationContext,
  nextStatus: string,
): Promise<void> {
  if (!nextStatus) {
    throw new Error("next_status is required for update-status");
  }
  await context.client.updateStatus(
    context.issueNumber,
    context.statusFieldId,
    nextStatus,
  );
}

export async function assignOwner(
  context: OperationContext,
  triggerActor: string,
  triggerActorType: string,
): Promise<void> {
  if (!triggerActor) {
    throw new Error("trigger_actor is required for assign-owner");
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
  const reviewer = await context.client.getLatestAssignedUser(context.issueNumber);
  if (!reviewer) {
    throw new Error("No assigned task owner found in the issue activity");
  }
  // A review request on a draft asks for a review of work GitHub still labels unfinished,
  // so the pull request leaves draft first and the reviewer is added to a ready one.
  await context.client.markPullRequestReadyForReview(pullNumber);
  await context.client.requestReviewer(pullNumber, reviewer);
  core.setOutput("reviewer", reviewer);
  return reviewer;
}

export async function reportProof(
  context: ProofContext,
  proofPath: string,
  options: ProofReportOptions = {},
): Promise<ProofDocument> {
  if (!proofPath) {
    throw new Error("proof_path is required for report-proof");
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
    nextSteps: proof.outcome !== "passed" ? options.failureGuidance : undefined,
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
    throw new Error("branch_name is required for resolve-task-pr");
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
  preparedBranchName?: string,
  preparedSkipValidation?: boolean,
  branchTemplate = defaultBranchTemplate,
): Promise<void> {
  if (
    (preparedBranchName === undefined) !==
      (preparedSkipValidation === undefined)
  ) {
    throw new Error(
      "prepared branch name and validation policy must be provided together",
    );
  }
  let branchName = preparedBranchName;
  let skipValidation = preparedSkipValidation;
  if (branchName === undefined || skipValidation === undefined) {
    const { config } = await loadEpicConfig(context);
    branchName = resolveTaskBranchName(
      config.id,
      context.issueNumber,
      branchTemplate,
    );
    skipValidation = config.skipValidation;
  }
  const failureStatus = "Blocked";

  if (!(await context.client.branchExists(branchName))) {
    core.warning("Task branch was not found. Issue left open for manual review.");
    await reportActivity(context, {
      status: failureStatus,
      outcome: "blocked",
      summary: "The task agent did not create the expected branch.",
      details: `- Expected branch: \`${branchName}\`\n- Move the task to \`Ready\` after resolving the blocker to retry.`,
    });
    // Updating status can trigger the next workflow, so all Octestra work must finish first.
    await context.client.updateStatus(
      context.issueNumber,
      context.statusFieldId,
      failureStatus,
    );
    return;
  }

  const nextStatus = skipValidation ? "Human Review" : "Validation";
  const pullNumber = await resolveTaskPullRequest(context, branchName);
  const reviewer = nextStatus === "Human Review"
    ? await requestReview(context, pullNumber)
    : undefined;

  await reportActivityBestEffort(context, {
    status: nextStatus,
    outcome: "succeeded",
    summary: reviewer
      ? `Created task PR #${pullNumber} and requested review from @${reviewer}.`
      : `Created task PR #${pullNumber} and queued validation.`,
    details: [
      `- Pull request: #${pullNumber}`,
      reviewer ? `- Reviewer: @${reviewer}` : undefined,
      `- AI Task Status updated to \`${nextStatus}\``,
    ].filter(Boolean).join("\n"),
  });
  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await context.client.updateStatus(
    context.issueNumber,
    context.statusFieldId,
    nextStatus,
  );
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
    failureGuidance: [
      "Move the task to `Validation` to run validation again on this pull request,",
      "or to `Ready` to restart the task after closing the pull request and deleting its branch.",
    ].join(" "),
  });
  if (proof.outcome !== "passed") {
    // Updating status can trigger the next workflow, so all Octestra work must finish first.
    await updateStatus(context, "Blocked");
    return;
  }

  await requestReview(context, pullNumber);
  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await updateStatus(context, "Human Review");
}

export async function reportFailure(
  context: OperationContext,
): Promise<void> {
  const failureStatus = "Blocked";
  const runUrl = workflowRunUrl();

  try {
    await reportActivity(context, {
      status: failureStatus,
      outcome: "failed",
      summary: "The task workflow failed or was cancelled.",
      details: [
        `- Failed workflow run: ${runUrl}`,
        "- Move the task to `Validation` to run validation again while its pull request is open,",
        "  or to `Ready` to restart the task after resolving the blocker.",
      ].join("\n"),
    });
  } catch (error) {
    core.warning(`Failed to post the task failure report: ${String(error)}`);
  }

  // Updating status can trigger the next workflow, so all Octestra work must finish first.
  await context.client.updateStatus(
    context.issueNumber,
    context.statusFieldId,
    failureStatus,
  );
}
