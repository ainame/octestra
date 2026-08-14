import path from "node:path";
import * as core from "@actions/core";
import { parseEpicConfig } from "../shared/issue-config";
import { markdownTable } from "../shared/markdown";
import { renderPrompt } from "../shared/prompt";

const maximumMatrixEntries = 256;
const todoPromptPath = ".github/octestra/prompts/loop-todo.md.hbs";

export interface LoopPrepareClient {
  getIssue(issueNumber: number): Promise<{
    title: string;
    body: string;
    state: string;
    labels: string[];
  }>;
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

type LoopPromptVariables = {
  epicNumber: number;
  triageSkill: string;
  epicTriagePrompt: string;
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
  const templatePath = path.join(
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
    todoPromptPath,
  );
  const variables: LoopPromptVariables = {
    epicNumber: context.epicNumber,
    triageSkill: epic.triageSkill,
    epicTriagePrompt: epic.epicTriagePrompt,
  };
  const prompt = await renderPrompt(templatePath, variables);
  core.setOutput("prompt", prompt);
  core.setOutput("prompt", prompt);
}
