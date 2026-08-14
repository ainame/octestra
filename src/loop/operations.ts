import path from "node:path";
import * as core from "@actions/core";
import { parseEpicConfig } from "../shared/issue-config";
import { markdownTable } from "../shared/markdown";
import { renderPrompt } from "../shared/prompt";
import { workflowRunUrl } from "../shared/workflow-run";

const maximumMatrixEntries = 256;

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

export interface LoopPromptContext {
  [key: string]: unknown;
}

type LoopPromptVariables = LoopPromptContext & {
  epicNumber: number;
  triageSkill: string;
  epicTriagePrompt: string;
  loopId: string;
  resultPath: string;
  artifactPath: string;
  runUrl: string;
};

function parsePromptContext(raw: string): LoopPromptContext {
  if (!raw) {
    return {};
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("loop-context must be a JSON object");
  }
  return value as LoopPromptContext;
}

function validateLoopId(loopId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(loopId)) {
    throw new Error("loop-id must be a non-empty lowercase slug");
  }
}

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
  loopId: string,
  promptPath: string,
  rawContext: string,
): Promise<void> {
  validateLoopId(loopId);
  if (!promptPath.trim()) {
    throw new Error("prompt-path must be a non-empty path");
  }

  const resultPath = `octestra-loop-${loopId}.md`;
  const artifactPath = `octestra-loop-${loopId}-artifacts`;
  const callerContext = parsePromptContext(rawContext);
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
  const reserved = [
    "epicNumber",
    "triageSkill",
    "epicTriagePrompt",
    "loopId",
    "resultPath",
    "artifactPath",
    "runUrl",
  ];
  const conflict = reserved.find((key) => Object.hasOwn(callerContext, key));
  if (conflict) {
    throw new Error(`loop-context cannot override ${conflict}`);
  }
  const templatePath = path.join(
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
    promptPath,
  );
  const variables: LoopPromptVariables = {
    ...callerContext,
    epicNumber: context.epicNumber,
    triageSkill: epic.triageSkill,
    epicTriagePrompt: epic.epicTriagePrompt,
    loopId,
    resultPath,
    artifactPath,
    runUrl: workflowRunUrl(),
  };
  const prompt = await renderPrompt(templatePath, variables);

  core.setOutput("prompt", prompt);
  core.setOutput("triage_skill", epic.triageSkill);
  core.setOutput("result_path", resultPath);
  core.setOutput("artifact_path", artifactPath);
}
