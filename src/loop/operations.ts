import path from "node:path";
import * as core from "@actions/core";
import {
  type ActivityClient,
  reportActivityBestEffort,
} from "../shared/activity";
import {
  parseEpicConfig,
  parseTaskConfig,
} from "../shared/issue-config";
import { markdownTable } from "../shared/markdown";
import { renderPrompt } from "../shared/prompt";
import {
  parseTriageResult,
  readJsonResult,
} from "../shared/result";

const maximumMatrixEntries = 256;

export interface LoopPrepareClient {
  getIssue(issueNumber: number): Promise<{
    title: string;
    body: string;
    state: string;
    labels: string[];
  }>;
}

export interface LoopFinalizeClient extends LoopPrepareClient, ActivityClient {
  getParentNumber(issueNumber: number): Promise<number>;
  getStatus(issueNumber: number, fieldId: number): Promise<string | undefined>;
  updateStatus(
    issueNumber: number,
    fieldId: number,
    status: string,
  ): Promise<void>;
}

export interface LoopDiscoveryClient {
  listOpenIssuesByLabel(
    label: string,
  ): Promise<Array<{ number: number; title: string; body: string }>>;
}

export interface LoopPrepareContext {
  client: LoopPrepareClient;
  epicNumber: number;
}

export interface LoopFinalizeContext {
  client: LoopFinalizeClient;
  epicNumber: number;
  statusFieldId: number;
}

type LoopPromptVariables = {
  epicNumber: number;
  triageSkill: string;
  epicTriagePrompt: string;
  resultPath: string;
};

export async function listEpics(client: LoopDiscoveryClient): Promise<void> {
  const issues = await client.listOpenIssuesByLabel("octestra-epic");
  const epics: Array<{ number: number }> = [];

  for (const issue of issues) {
    let config;
    try {
      config = parseEpicConfig(issue.body);
    } catch (error) {
      throw new Error(
        `EPIC #${issue.number} has invalid configuration: ${String(error)}`,
      );
    }
    if (config.skipTriage) {
      continue;
    }
    if (!config.triageSkill) {
      throw new Error(
        `EPIC #${issue.number} enables Todo triage but epic-config triage_skill is empty`,
      );
    }
    epics.push({ number: issue.number });
  }

  if (epics.length > maximumMatrixEntries) {
    throw new Error(
      `Todo triage found ${epics.length} enabled EPICs; GitHub Actions supports at most ${maximumMatrixEntries} matrix jobs`,
    );
  }

  core.setOutput("epics", JSON.stringify(epics));
  core.setOutput("count", String(epics.length));
  core.summary.addRaw(markdownTable(["Field", "Value"], [
    ["Open EPICs", String(issues.length)],
    ["Todo triage enabled", String(epics.length)],
  ]));
  await core.summary.write();
}

export async function prepareTriage(
  context: LoopPrepareContext,
  promptTemplate: string,
): Promise<void> {
  const issue = await context.client.getIssue(context.epicNumber);
  if (issue.state !== "open" || !issue.labels.includes("octestra-epic")) {
    throw new Error(
      `EPIC #${context.epicNumber} is no longer an open octestra-epic issue`,
    );
  }
  const epic = parseEpicConfig(issue.body);
  if (epic.skipTriage) {
    throw new Error(
      `EPIC #${context.epicNumber} has skip_triage enabled`,
    );
  }
  if (!epic.triageSkill) {
    throw new Error("epic-config triage_skill must be a non-empty string for loop/todo");
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    throw new Error("RUNNER_TEMP must be set");
  }
  const resultPath = path.join(runnerTemp, "octestra-triage-result.json");
  const templatePath = path.join(
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
    promptTemplate,
  );
  const variables: LoopPromptVariables = {
    epicNumber: context.epicNumber,
    triageSkill: epic.triageSkill,
    epicTriagePrompt: epic.epicTriagePrompt,
    resultPath,
  };
  const prompt = await renderPrompt(templatePath, variables);
  core.setOutput("triage_skill", epic.triageSkill);
  core.setOutput("prompt", prompt);
  core.setOutput("result_path", resultPath);
}

async function requireEligibleEpic(
  context: LoopFinalizeContext,
): Promise<void> {
  const issue = await context.client.getIssue(context.epicNumber);
  if (issue.state !== "open" || !issue.labels.includes("octestra-epic")) {
    throw new Error(
      `EPIC #${context.epicNumber} is no longer an open octestra-epic issue`,
    );
  }
  const epic = parseEpicConfig(issue.body);
  if (epic.skipTriage) {
    throw new Error(`EPIC #${context.epicNumber} has skip_triage enabled`);
  }
  if (!epic.triageSkill) {
    throw new Error(
      `EPIC #${context.epicNumber} enables Todo triage but epic-config triage_skill is empty`,
    );
  }
}

export async function finalizeTriage(
  context: LoopFinalizeContext,
  resultPath: string,
): Promise<void> {
  if (!resultPath) {
    throw new Error("result_path is required for loop/finalize-triage");
  }
  const result = parseTriageResult(await readJsonResult(resultPath));
  await requireEligibleEpic(context);

  for (const issueNumber of result.readyIssues) {
    const issue = await context.client.getIssue(issueNumber);
    if (issue.state !== "open") {
      throw new Error(`Reported task #${issueNumber} is not open`);
    }
    const parentNumber = await context.client.getParentNumber(issueNumber);
    if (parentNumber !== context.epicNumber) {
      throw new Error(
        `Reported task #${issueNumber} is not a direct sub-issue of EPIC #${context.epicNumber}`,
      );
    }
    try {
      parseTaskConfig(issue.body);
    } catch (error) {
      throw new Error(
        `Reported task #${issueNumber} has an invalid task body: ${String(error)}`,
      );
    }
    const status = await context.client.getStatus(
      issueNumber,
      context.statusFieldId,
    );
    if (status !== "Todo" && status !== "Ready") {
      throw new Error(
        `Reported task #${issueNumber} has status ${status ?? "(unset)"}, not Todo or Ready`,
      );
    }
  }

  // All issue validation finishes before this second EPIC check and the write phase.
  await requireEligibleEpic(context);

  let updated = 0;
  for (const issueNumber of result.readyIssues) {
    const status = await context.client.getStatus(
      issueNumber,
      context.statusFieldId,
    );
    if (status === "Ready") {
      core.info(`Task #${issueNumber} is already Ready`);
      continue;
    }
    if (status !== "Todo") {
      throw new Error(
        `Reported task #${issueNumber} changed to ${status ?? "(unset)"} before update`,
      );
    }
    await reportActivityBestEffort(
      {
        client: context.client,
        issueNumber,
      },
      {
        status: "Ready",
        outcome: "succeeded",
        summary: `Todo triage selected this task from EPIC #${context.epicNumber} and queued it for execution.`,
        details: [
          `- Source EPIC: #${context.epicNumber}`,
          "- AI Task Status transition: `Todo` to `Ready`",
        ].join("\n"),
      },
    );
    // Status changes can trigger lifecycle workflows, so they remain the final side effects.
    await context.client.updateStatus(
      issueNumber,
      context.statusFieldId,
      "Ready",
    );
    updated += 1;
  }
  core.setOutput("ready_count", String(updated));
}
