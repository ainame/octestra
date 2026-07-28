import { describe, expect, it } from "vitest";
import { parseProofDocument, renderProofComment } from "./proof";

describe("parseProofDocument", () => {
  it("accepts the small convention while ignoring consumer-specific fields", () => {
    expect(parseProofDocument({
      outcome: "passed",
      summary: "The task works.",
      consumerSpecific: { anything: true },
    })).toEqual({
      outcome: "passed",
      summary: "The task works.",
      details: undefined,
      acceptance: undefined,
      checks: undefined,
      evidence: undefined,
      artifacts: undefined,
      knownGaps: undefined,
    });
  });

  it("rejects malformed recognized sections", () => {
    expect(() => parseProofDocument({
      outcome: "passed",
      summary: "The task works.",
      checks: "unit tests passed",
    })).toThrow("Proof checks must be an array of objects");
  });
});

describe("renderProofComment", () => {
  it("keeps the result prominent and collapses verbose metadata", () => {
    const comment = renderProofComment(
      parseProofDocument({
        outcome: "passed",
        summary: "The profile flow behaves as expected.",
        acceptance: [{
          id: "AC-1",
          criterion: "The profile loads",
          result: "passed",
          evidence: "UI flow",
        }],
        checks: [{
          name: "Goal-based UI validation",
          kind: "agentic E2E",
          scope: ["AC-1"],
          status: "passed",
          evidence: "recording.mp4",
        }],
        artifacts: [{
          name: "UI recording",
          kind: "video",
          path: "recording.mp4",
        }],
        details: "Executed the consumer-defined validation prompt.",
      }),
      {
        issueNumber: 123,
        pullNumber: 42,
        subjectSha: "abcdef1234567890",
        owner: "reviewer",
        actor: "github-actions[bot]",
        runUrl: "https://github.com/ainame/octestra/actions/runs/1",
        runAttempt: "2",
        recordedAt: "2026-07-24T21:00:00.000Z",
      },
    );

    expect(comment).toContain("## ✅ Passed validation proof");
    expect(comment).toContain("| AC-1 | The profile loads | ✅ Passed | UI flow |");
    expect(comment).toContain(
      "| Goal-based UI validation | agentic E2E | AC-1 | ✅ Passed | recording.mp4 |",
    );
    expect(comment).toContain("<summary>Additional details</summary>");
    expect(comment).toContain("<summary>Technical metadata</summary>");
    expect(comment.indexOf("The profile flow behaves as expected.")).toBeLessThan(
      comment.indexOf("<summary>Technical metadata</summary>"),
    );
  });
});
