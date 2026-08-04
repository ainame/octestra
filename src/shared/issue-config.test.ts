import { describe, expect, it } from "vitest";
import { parseEpicConfig, parseTaskConfig } from "./issue-config";

describe("parseEpicConfig", () => {
  it("parses required configuration and optional prompt", () => {
    const result = parseEpicConfig(`
\`\`\`epic-config
id: objc-to-swift
skill: objc-to-swift
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
      skillName: "objc-to-swift",
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
skill: migrate-storyboard-uikit
\`\`\`
`);

    expect(result.draftPr).toBe(false);
    expect(result.skipValidation).toBe(false);
    expect(result.epicTaskPrompt).toBe("");
    expect(result.epicValidationPrompt).toBe("");
  });

  it("permits an EPIC without an agent skill", () => {
    expect(parseEpicConfig(`
\`\`\`epic-config
id: manual-migration
draft_pr: true
\`\`\`
`)).toMatchObject({ id: "manual-migration", skillName: undefined });
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
skill: migrate-storyboard-uikit
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
