import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";

export type PromptVariables = Record<string, unknown>;

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
