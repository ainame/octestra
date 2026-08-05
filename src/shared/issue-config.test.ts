import { describe, expect, it } from "vitest";
import { parseEpicConfig, parseTaskConfig } from "./issue-config";

describe("parseEpicConfig", () => {
  it("parses required configuration and optional prompt", () => {
    const result = parseEpicConfig(`
\`\`\`epic-config
id: objc-to-swift
task_skill: objc-to-swift
validation_skill:
draft_pr: true
skip_validation: true
\`\`\`

\`\`\`epic-task-prompt
Keep the public API unchanged.
\`\`\`

\`\`\`epic-validation-prompt
Verify that the target implementation has been migrated from Objective-C to Swift.
\`\`\`
`);

    expect(result).toEqual({
      id: "objc-to-swift",
      taskSkillName: "objc-to-swift",
      validationSkillName: undefined,
      draftPr: true,
      skipValidation: true,
      epicTaskPrompt: "Keep the public API unchanged.",
      epicValidationPrompt: "Verify that the target implementation has been migrated from Objective-C to Swift.",
    });
  });

  it("opens a pull request ready for review and validates it by default", () => {
    const result = parseEpicConfig(`
\`\`\`epic-config
id: migrate-storyboard-uikit
task_skill: migrate-storyboard-uikit
validation_skill: ios-ui-validation
\`\`\`
`);

    expect(result.draftPr).toBe(false);
    expect(result.skipValidation).toBe(false);
    expect(result.taskSkillName).toBe("migrate-storyboard-uikit");
    expect(result.validationSkillName).toBe("ios-ui-validation");
    expect(result.epicTaskPrompt).toBe("");
    expect(result.epicValidationPrompt).toBe("");
  });

  it("permits an EPIC without a task skill", () => {
    expect(parseEpicConfig(`
\`\`\`epic-config
id: manual-migration
validation_skill: manual-validation
draft_pr: true
\`\`\`
`)).toMatchObject({
      id: "manual-migration",
      taskSkillName: undefined,
      validationSkillName: "manual-validation",
    });
  });

  it("permits an empty validation skill when validation is skipped", () => {
    expect(parseEpicConfig(`
\`\`\`epic-config
id: manual-migration
task_skill:
validation_skill:
skip_validation: true
\`\`\`
`)).toMatchObject({
      taskSkillName: undefined,
      validationSkillName: undefined,
      skipValidation: true,
    });
  });

  it("requires a validation skill when validation runs", () => {
    expect(() => parseEpicConfig(`
\`\`\`epic-config
id: migrate-storyboard-uikit
task_skill: migrate-storyboard-uikit
validation_skill:
\`\`\`
`)).toThrow("validation_skill must be a non-empty string");
  });

  it("rejects a missing ID", () => {
    expect(() =>
      parseEpicConfig(`
\`\`\`epic-config
draft_pr: true
\`\`\`
`),
    ).toThrow("non-empty lowercase slug");
  });

  it("rejects a non-boolean skip_validation value", () => {
    expect(() =>
      parseEpicConfig(`
\`\`\`epic-config
id: migrate-storyboard-uikit
task_skill: migrate-storyboard-uikit
validation_skill: ios-ui-validation
skip_validation: "false"
\`\`\`
`),
    ).toThrow("skip_validation must be true or false");
  });
});

describe("parseTaskConfig", () => {
  it("parses an optional target and validation prompt", () => {
    expect(parseTaskConfig(`
\`\`\`task-config
target: Sources/Feature/Home.swift
\`\`\`

\`\`\`task-prompt
Preserve the existing public API.
\`\`\`

\`\`\`validation-prompt
Confirm the screen preserves the existing public API.
\`\`\`
`)).toEqual({
      target: "Sources/Feature/Home.swift",
      taskPrompt: "Preserve the existing public API.",
      validationPrompt: "Confirm the screen preserves the existing public API.",
    });
  });

  it.each([
    "target:",
    "target: null",
    'target: ""',
    "target: N/A",
  ])("treats an empty target as unspecified: %s", (configuration) => {
    expect(parseTaskConfig(`
\`\`\`task-config
${configuration}
\`\`\`
`)).toEqual({
      target: undefined,
      taskPrompt: "",
      validationPrompt: "",
    });
  });

  it("rejects a non-string target", () => {
    expect(() => parseTaskConfig(`
\`\`\`task-config
target: 123
\`\`\`
`)).toThrow("target must be a string or null");
  });

  it("parses a task-specific prompt", () => {
    expect(parseTaskConfig(`
\`\`\`task-config
target: null
\`\`\`

\`\`\`task-prompt
Create the adapter behind the existing interface.
\`\`\`

\`\`\`validation-prompt
Verify the adapter behavior.
\`\`\`
`)).toEqual({
      target: undefined,
      taskPrompt: "Create the adapter behind the existing interface.",
      validationPrompt: "Verify the adapter behavior.",
    });
  });

  it("permits a task without validation instructions", () => {
    expect(parseTaskConfig(`
\`\`\`task-config
target: Sources/Feature/Home.swift
\`\`\`
`)).toEqual({
      target: "Sources/Feature/Home.swift",
      taskPrompt: "",
      validationPrompt: "",
    });
  });
});
