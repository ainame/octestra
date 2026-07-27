import path from "node:path";
import * as core from "@actions/core";
import type { OperationsClient } from "../lifecycle/operations";
import type { LoopConfig, OctestraConfig } from "../shared/config";
import { renderPrompt, type PromptVariables } from "../shared/prompt";
import { readProofDocument, renderProofComment } from "../shared/proof";

export const defaultLoopBranchTemplate = "octestra/loop/{loop_id}/{run_number}";

export interface LoopIssue {
  number: number;
  title: string;
  updated_at: string;
  pull_request?: unknown;
}
export interface ListedIssues {
  issues: LoopIssue[];
  partial: boolean;
}
export interface LoopClient extends OperationsClient {
  listIssues(labels: string[], scanBudget: number): Promise<ListedIssues>;
  listSubIssues(epic: number, scanBudget: number): Promise<ListedIssues>;
}
export interface LoopContext {
  loop_id: string;
  trigger: string;
  dry_run: boolean;
  config_ref: string;
}
export function parseLoopContext(raw: string): LoopContext {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("loop-context must contain loop_id");
  const context = value as Record<string, unknown>;
  if (typeof context.loop_id !== "string" || !context.loop_id) throw new Error("loop-context must contain loop_id");
  return { loop_id: context.loop_id, trigger: typeof context.trigger === "string" ? context.trigger : "", dry_run: context.dry_run === true, config_ref: typeof context.config_ref === "string" ? context.config_ref : "" };
}
export interface LoopSelection {
  number: number;
  title: string;
  status: string;
  updated_at: string;
}
export function parseLoopSelection(raw: string): LoopSelection[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("loop-issues must be a JSON array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`loop-issues[${index}] must be an object`);
    const issue = entry as Record<string, unknown>;
    if (typeof issue.number !== "number" || !Number.isSafeInteger(issue.number) || issue.number <= 0) throw new Error(`loop-issues[${index}].number must be a positive integer`);
    return {
      number: issue.number,
      title: typeof issue.title === "string" ? issue.title : "",
      status: typeof issue.status === "string" ? issue.status : "",
      updated_at: typeof issue.updated_at === "string" ? issue.updated_at : "",
    };
  });
}
export function resolveLoopBranchName(template: string, loopId: string, runNumber: string): string {
  if (!template.includes("{loop_id}") || !template.includes("{run_number}")) {
    throw new Error("config.yml branch.loop must include {loop_id} and {run_number}");
  }
  if (!runNumber) throw new Error("loop branch name requires a run number");
  const branchName = template.replaceAll("{loop_id}", loopId).replaceAll("{run_number}", runNumber);
  if (branchName.includes("..") || branchName.startsWith("/") || branchName.endsWith("/")) {
    throw new Error(`branch template resolved to an invalid branch name: ${branchName}`);
  }
  return branchName;
}
function emitSelection(issues: Array<{ number: number; title: string; status: string; updated_at: string }>, partial: boolean): void {
  core.setOutput("issues", JSON.stringify(issues));
  core.setOutput("count", String(issues.length));
  core.setOutput("loop_ready", String(issues.length > 0));
  core.setOutput("partial", String(partial));
  const digest = issues.length ? ["| Issue | Title |", "| --- | --- |", ...issues.map((issue) => `| #${issue.number} | ${issue.title} |`)].join("\n") : "No matching tasks.";
  core.setOutput("digest", digest);
}
function filteredCandidates(issues: LoopIssue[], config: LoopConfig, now: Date): LoopIssue[] {
  const cutoff = config.select.updated_before === undefined ? undefined : now.getTime() - config.select.updated_before * 1000;
  return issues.filter((candidate) => !candidate.pull_request).filter((candidate) => cutoff === undefined || Date.parse(candidate.updated_at) < cutoff).sort((left, right) => config.select.order === "oldest" ? Date.parse(left.updated_at) - Date.parse(right.updated_at) : Date.parse(right.updated_at) - Date.parse(left.updated_at));
}
export async function selectTasks(client: LoopClient, config: LoopConfig, statusFieldName: string, now = new Date()): Promise<void> {
  const listed = config.select.epic === null ? await client.listIssues(config.select.labels, config.select.scan_budget) : await client.listSubIssues(config.select.epic, config.select.scan_budget);
  const selected: Array<{ number: number; title: string; status: string; updated_at: string }> = [];
  for (const candidate of filteredCandidates(listed.issues, config, now)) {
    if (await client.getStatus(candidate.number, statusFieldName) !== config.select.status) continue;
    selected.push({ number: candidate.number, title: candidate.title, status: config.select.status, updated_at: candidate.updated_at });
    if (selected.length === Math.min(config.select.limit, 256)) break;
  }
  emitSelection(selected, listed.partial);
}
export interface PrepareRunOptions {
  issueNumber?: number;
  issues?: LoopSelection[];
  runNumber?: string;
  branchTemplate?: string;
}
export async function prepareRun(loop: LoopContext, config: LoopConfig, options: PrepareRunOptions): Promise<void> {
  const scope = options.issueNumber === undefined ? loop.loop_id : `${loop.loop_id}-${options.issueNumber}`;
  const resultPath = `octestra-loop-${scope}.json`;
  const artifactPath = `octestra-loop-${scope}-artifacts`;
  const patchPath = `octestra-loop-${scope}.patch`;
  const templatePath = path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), config.prompt);
  core.setOutput("result_path", resultPath);
  core.setOutput("artifact_path", artifactPath);
  core.setOutput("patch_path", patchPath);
  const variables: PromptVariables = { resultPath, artifactPath, patchPath, loopId: loop.loop_id };
  if (options.issueNumber === undefined) {
    const issues = options.issues ?? [];
    const branchName = resolveLoopBranchName(options.branchTemplate ?? defaultLoopBranchTemplate, loop.loop_id, options.runNumber ?? "");
    core.setOutput("branch_name", branchName);
    variables.branchName = branchName;
    variables.runNumber = options.runNumber ?? "";
    variables.issues = issues;
    variables.issueCount = issues.length;
  } else {
    variables.issueNumber = options.issueNumber;
  }
  core.setOutput("prompt", await renderPrompt(templatePath, variables));
}
export async function finalizeRun(client: OperationsClient, config: LoopConfig, statusFieldName: string, proofPath: string, requestedDryRun: boolean, issueNumber?: number): Promise<void> {
  const target = issueNumber ?? config.report_issue;
  if (!target) throw new Error("loop/finalize-run needs an issue-number or a configured report_issue");
  const dryRun = requestedDryRun || config.apply.dry_run;
  const proof = await readProofDocument(proofPath);
  await client.comment(target, renderProofComment(proof, { issueNumber: target }));
  core.setOutput("outcome", proof.outcome);
  const nextStatus = proof.nextStatus;
  if (issueNumber === undefined || !nextStatus || !config.apply.allowed_status.includes(nextStatus) || dryRun) {
    core.setOutput("applied", "false");
    return;
  }
  if (config.apply.assign_owner) {
    const owner = await client.getLatestAssignedUser(issueNumber);
    if (!owner) throw new Error(`Loop cannot promote issue #${issueNumber}: no task owner is assigned`);
    await client.assignIssue(issueNumber, owner);
  }
  await client.updateStatus(issueNumber, statusFieldName, nextStatus);
  core.setOutput("applied", "true");
}
export async function reportFailure(client: OperationsClient, loop: LoopContext, config: LoopConfig): Promise<void> {
  const message = `Octestra loop ${loop.loop_id} failed: ${(process.env.GITHUB_SERVER_URL ?? "https://github.com")}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (!config.report_issue) {
    core.error(message);
    throw new Error(`Loop ${loop.loop_id} has no report_issue configured`);
  }
  await client.comment(config.report_issue, message);
}
export function loopDefinition(config: OctestraConfig, loop: LoopContext): LoopConfig {
  const definition = config.loops[loop.loop_id];
  if (!definition) throw new Error(`Unknown loop: ${loop.loop_id}`);
  return definition;
}
