import { describe, expect, it } from "vitest";
import { parseEpicConfig, parseTaskConfig } from "./config";

describe("parseEpicConfig", () => {
  it("parses required configuration and optional prompt", () => {
    const result = parseEpicConfig(`
\`\`\`epic-config
id: objc-to-swift
skill: objc-to-swift
draft_pr: false
validation_required: false
\`\`\`

\`\`\`epic-prompt
Keep the public API unchanged.
\`\`\`

\`\`\`validation-prompt
Verify that the target implementation has been migrated from Objective-C to Swift.
\`\`\`
`);

    expect(result).toEqual({
      id: "objc-to-swift",
      skillName: "objc-to-swift",
      draftPr: false,
      validationRequired: false,
      epicPrompt: "Keep the public API unchanged.",
      validationPrompt: "Verify that the target implementation has been migrated from Objective-C to Swift.",
    });
  });

  it("defaults draft PR to true", () => {
    const result = parseEpicConfig(`
\`\`\`epic-config
id: migrate-storyboard-uikit
skill: migrate-storyboard-uikit
\`\`\`
`);

    expect(result.draftPr).toBe(true);
    expect(result.validationRequired).toBe(false);
    expect(result.epicPrompt).toBe("");
    expect(result.validationPrompt).toBe("");
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

  it("rejects a non-boolean validation_required value", () => {
    expect(() =>
      parseEpicConfig(`
\`\`\`epic-config
id: migrate-storyboard-uikit
skill: migrate-storyboard-uikit
validation_required: "false"
\`\`\`
`),
    ).toThrow("validation_required must be true or false");
  });
});

describe("parseTaskConfig", () => {
  it("parses an optional target", () => {
    expect(parseTaskConfig(`
\`\`\`task-config
target: Sources/Feature/Home.swift
\`\`\`

\`\`\`task-prompt
Preserve the existing public API.
\`\`\`
`)).toEqual({
      target: "Sources/Feature/Home.swift",
      taskPrompt: "Preserve the existing public API.",
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
`)).toEqual({ target: undefined, taskPrompt: "" });
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
`)).toEqual({
      target: undefined,
      taskPrompt: "Create the adapter behind the existing interface.",
    });
  });
});
