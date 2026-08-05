import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPrompt } from "./prompt";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("renderPrompt", () => {
  it("renders migration variables without HTML escaping", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "octestra-prompt-"));
    temporaryDirectories.push(directory);
    const templatePath = path.join(directory, "prompt.md.hbs");
    await writeFile(
      templatePath,
      "/{{taskSkillName}} /{{validationSkillName}} {{target}} {{epicTaskPrompt}} {{taskPrompt}} {{epicValidationPrompt}} {{validationPrompt}} #{{issueNumber}} {{draftFlag}}",
    );

    const result = await renderPrompt(templatePath, {
      taskSkillName: "example-task",
      validationSkillName: "example-validation",
      target: "Sources/A&B.swift",
      epicTaskPrompt: "Keep <API>",
      taskPrompt: "Update the adapter.",
      epicValidationPrompt: "Run integration tests.",
      validationPrompt: "Verify the migration.",
      issueNumber: 123,
      pullNumber: undefined,
      draftFlag: "--draft",
      resultPath: "",
      artifactPath: "",
    });

    expect(result).toBe(
      "/example-task /example-validation Sources/A&B.swift Keep <API> Update the adapter. Run integration tests. Verify the migration. #123 --draft",
    );
  });
});
