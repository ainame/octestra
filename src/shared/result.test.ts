import { describe, expect, it } from "vitest";
import {
  parseTriageResult,
  parseValidationResult,
} from "./result";

describe("parseTriageResult", () => {
  it("accepts an empty result and an optional summary", () => {
    expect(parseTriageResult({
      kind: "triage-result",
      readyIssues: [],
      summary: "Nothing is ready.",
    })).toEqual({
      kind: "triage-result",
      readyIssues: [],
      summary: "Nothing is ready.",
    });
  });

  it.each([
    [["12"], "readyIssues[0] must be a positive issue number"],
    [[0], "readyIssues[0] must be a positive issue number"],
    [[1, 1], "readyIssues must not contain duplicates"],
  ])("rejects invalid ready issue numbers", (readyIssues, message) => {
    expect(() => parseTriageResult({
      kind: "triage-result",
      readyIssues,
    })).toThrow(message);
  });

  it("requires the triage discriminator", () => {
    expect(() => parseTriageResult({
      readyIssues: [],
    })).toThrow("kind must be triage-result");
  });
});

describe("parseValidationResult", () => {
  it("requires the validation discriminator", () => {
    expect(() => parseValidationResult({
      outcome: "passed",
      summary: "Validated.",
    })).toThrow("kind must be validation-result");
  });

  it("limits lifecycle outcomes to passed and failed", () => {
    expect(() => parseValidationResult({
      kind: "validation-result",
      outcome: "blocked",
      summary: "Could not validate.",
    })).toThrow("outcome must be passed or failed");
  });
});
