import path from "node:path";
import * as core from "@actions/core";
import { renderPrompt } from "../shared/prompt";
import { readProofDocument, renderProofComment } from "../shared/proof";
import type { LoopConfig, OctestraConfig } from "../shared/config";
import type { OperationsClient } from "../lifecycle/operations";

export interface LoopIssue { number: number; title: string; updated_at: string; pull_request?: unknown; }
export interface ListedIssues { issues: LoopIssue[]; partial: boolean; }
export interface LoopClient extends OperationsClient {
  listIssues(labels: string[], scanBudget: number): Promise<ListedIssues>;
  listSubIssues(epic: number, scanBudget: number): Promise<ListedIssues>;
}
export interface LoopContext { loop_id: string; trigger: string; dry_run: boolean; config_ref: string; }
export function parseLoopContext(raw: string): LoopContext {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).loop_id !== "string") throw new Error("loop-context must contain loop_id");
  const context = value as Record<string, unknown>;
  return { loop_id: context.loop_id as string, trigger: typeof context.trigger === "string" ? context.trigger : "", dry_run: context.dry_run === true, config_ref: typeof context.config_ref === "string" ? context.config_ref : "" };
}
function emitSelection(issues: Array<{ number: number; title: string; status: string; updated_at: string }>, partial: boolean): void {
  core.setOutput("issues", JSON.stringify(issues)); core.setOutput("count", String(issues.length)); core.setOutput("loop_ready", String(issues.length > 0)); core.setOutput("partial", String(partial));
  core.setOutput("digest", issues.length ? ["| Issue | Title |", "| --- | --- |", ...issues.map((issue) => `| #${issue.number} | ${issue.title} |`)].join("\n") : "No matching tasks.");
}
export async function selectTasks(client: LoopClient, config: LoopConfig, statusFieldName: string): Promise<void> {
  const listed = config.select.epic === null ? await client.listIssues(config.select.labels, config.select.scan_budget) : await client.listSubIssues(config.select.epic, config.select.scan_budget);
  const selected: Array<{ number: number; title: string; status: string; updated_at: string }> = [];
  for (const candidate of listed.issues) {
    if (candidate.pull_request) continue;
    if (await client.getStatus(candidate.number, statusFieldName) !== config.select.status) continue;
    selected.push({ number: candidate.number, title: candidate.title, status: config.select.status, updated_at: candidate.updated_at });
    if (selected.length === Math.min(config.select.limit, 256)) break;
  }
  emitSelection(selected, listed.partial);
}
export async function prepareRun(loop: LoopContext, config: LoopConfig, issueNumber: number): Promise<void> {
  const resultPath = `octestra-loop-${loop.loop_id}-${issueNumber}.json`;
  const artifactPath = `octestra-loop-${loop.loop_id}-${issueNumber}-artifacts`;
  const templatePath = path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), config.prompt);
  core.setOutput("result_path", resultPath); core.setOutput("artifact_path", artifactPath);
  core.setOutput("prompt", await renderPrompt(templatePath, { skillName: "", epicPrompt: "", issueNumber, pullNumber: undefined, draftFlag: "", resultPath, artifactPath }));
}
export async function finalizeRun(client: OperationsClient, issueNumber: number, config: LoopConfig, statusFieldName: string, proofPath: string, dryRun: boolean): Promise<void> {
  const proof = await readProofDocument(proofPath);
  await client.comment(issueNumber, renderProofComment(proof, { issueNumber }));
  const nextStatus = proof.nextStatus;
  if (!nextStatus || !config.apply.allowed_status.includes(nextStatus) || dryRun) { core.setOutput("applied", "false"); core.setOutput("outcome", proof.outcome); return; }
  if (config.apply.assign_owner) { const owner = await client.getLatestAssignedUser(issueNumber); if (!owner) throw new Error(`Loop cannot promote issue #${issueNumber}: no task owner is assigned`); await client.assignIssue(issueNumber, owner); }
  await client.updateStatus(issueNumber, statusFieldName, nextStatus);
  core.setOutput("applied", "true"); core.setOutput("outcome", proof.outcome);
}
export async function reportFailure(client: OperationsClient, loop: LoopContext, config: LoopConfig): Promise<void> {
  const message = `Octestra loop ${loop.loop_id} failed: ${(process.env.GITHUB_SERVER_URL ?? "https://github.com")}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (!config.report_issue) { core.error(message); throw new Error(`Loop ${loop.loop_id} has no report_issue configured`); }
  await client.comment(config.report_issue, message);
}
export function loopDefinition(config: OctestraConfig, loop: LoopContext): LoopConfig { const definition = config.loops[loop.loop_id]; if (!definition) throw new Error(`Unknown loop: ${loop.loop_id}`); return definition; }
