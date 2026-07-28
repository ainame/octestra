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
      "/{{skillName}} {{target}} {{epicPrompt}} #{{issueNumber}} {{draftFlag}}",
    );

    const result = await renderPrompt(templatePath, {
      skillName: "example",
      target: "Sources/A&B.swift",
      epicPrompt: "Keep <API>",
      issueNumber: 123,
      pullNumber: undefined,
      draftFlag: "--draft",
      resultPath: "",
      artifactPath: "",
    });

    expect(result).toBe("/example Sources/A&B.swift Keep <API> #123 --draft");
  });
});
