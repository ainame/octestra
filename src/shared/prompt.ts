import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";

export interface PromptLoopIssue {
  number: number;
  title: string;
  status: string;
  updated_at: string;
}

export interface PromptVariables {
  skillName?: string;
  target?: string;
  epicPrompt?: string;
  issueNumber?: number;
  pullNumber?: number | undefined;
  draftFlag?: string;
  resultPath: string;
  artifactPath: string;
  loopId?: string;
  runNumber?: string;
  branchName?: string;
  patchPath?: string;
  issues?: PromptLoopIssue[];
  issueCount?: number;
}

export async function renderPrompt(
  templatePath: string,
  variables: PromptVariables,
): Promise<string> {
  const templateSource = await readFile(templatePath, "utf8");
  const template = Handlebars.compile(templateSource, {
    noEscape: true,
    strict: true,
  });
  return template(variables);
}
