import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";

export interface PromptVariables {
  skillName?: string;
  target?: string;
  epicTaskPrompt?: string;
  taskPrompt?: string;
  epicValidationPrompt?: string;
  validationPrompt?: string;
  issueNumber?: number;
  pullNumber?: number | undefined;
  draftFlag?: string;
  resultPath: string;
  artifactPath: string;
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
