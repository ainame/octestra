import { describe, expect, it } from "vitest";
import { parseArtifactLinks, parseProofDocument, renderProofComment } from "./proof";

describe("parseProofDocument", () => {
  it("accepts the small convention while ignoring consumer-specific fields", () => {
    expect(parseProofDocument({
      kind: "validation-result",
      outcome: "passed",
      summary: "The task works.",
      consumerSpecific: { anything: true },
    })).toEqual({
      kind: "validation-result",
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
      kind: "validation-result",
      outcome: "passed",
      summary: "The task works.",
      checks: "unit tests passed",
    })).toThrow("Validation result checks must be an array of objects");
  });

  it("requires a name and result for each check while allowing custom fields", () => {
    expect(parseProofDocument({
      kind: "validation-result",
      outcome: "passed",
      summary: "The task works.",
      checks: [{
        name: "Unit tests",
        result: "passed",
        customField: { packages: 3 },
      }],
    }).checks).toEqual([{
      name: "Unit tests",
      result: "passed",
      customField: { packages: 3 },
    }]);

    expect(() => parseProofDocument({
      kind: "validation-result",
      outcome: "passed",
      summary: "The task works.",
      checks: [{ result: "passed" }],
    })).toThrow(
      "Validation result checks[0].name must be a non-empty string",
    );
    expect(() => parseProofDocument({
      kind: "validation-result",
      outcome: "passed",
      summary: "The task works.",
      checks: [{ name: "Unit tests" }],
    })).toThrow(
      "Validation result checks[0].result must be a non-empty string",
    );
  });
});

describe("renderProofComment", () => {
  it("keeps the result prominent and collapses verbose metadata", () => {
    const comment = renderProofComment(
      parseProofDocument({
        kind: "validation-result",
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
          result: "passed",
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
    expect(comment).not.toContain("### Next steps");
  });

  it("renders next steps ahead of the collapsed sections when provided", () => {
    const comment = renderProofComment(
      parseProofDocument({
        kind: "validation-result",
        outcome: "failed",
        summary: "The profile flow does not load.",
        details: "Executed the consumer-defined validation prompt.",
      }),
      {
        issueNumber: 123,
        pullNumber: 42,
        recordedAt: "2026-07-24T21:00:00.000Z",
        nextSteps: "Move the task to `Validation` to run validation again.",
      },
    );

    expect(comment).toContain("### Next steps");
    expect(comment).toContain(
      "Move the task to `Validation` to run validation again.",
    );
    expect(comment.indexOf("### Next steps")).toBeLessThan(
      comment.indexOf("<summary>Additional details</summary>"),
    );
  });

  it("links the uploaded artifact in the overview, outside the collapsed metadata", () => {
    const comment = renderProofComment(
      parseProofDocument({
        kind: "validation-result",
        outcome: "passed",
        summary: "The profile flow behaves as expected.",
        details: "Executed the consumer-defined validation prompt.",
      }),
      {
        issueNumber: 123,
        pullNumber: 42,
        recordedAt: "2026-07-24T21:00:00.000Z",
        artifactLinks: [{
          name: "octestra-validation-123-attempt-1",
          url: "https://github.com/ainame/octestra/actions/runs/1/artifacts/99",
        }],
      },
    );

    const artifactRow = "| Artifacts | [octestra-validation-123-attempt-1]"
      + "(https://github.com/ainame/octestra/actions/runs/1/artifacts/99) |";
    expect(comment).toContain(artifactRow);
    expect(comment.indexOf(artifactRow)).toBeLessThan(
      comment.indexOf("<summary>Additional details</summary>"),
    );
  });

  it("numbers unnamed links when several artifacts were uploaded", () => {
    const comment = renderProofComment(
      parseProofDocument({
        kind: "validation-result",
        outcome: "passed",
        summary: "The profile flow behaves as expected.",
        details: "Executed the consumer-defined validation prompt.",
      }),
      {
        issueNumber: 123,
        recordedAt: "2026-07-24T21:00:00.000Z",
        artifactLinks: [
          { url: "https://github.com/ainame/octestra/actions/runs/1/artifacts/99" },
          { name: "recordings", url: "https://github.com/ainame/octestra/actions/runs/1/artifacts/100" },
        ],
      },
    );

    expect(comment).toContain(
      "| Artifacts | [Artifact 1](https://github.com/ainame/octestra/actions/runs/1/artifacts/99) · "
        + "[recordings](https://github.com/ainame/octestra/actions/runs/1/artifacts/100) |",
    );
  });

  it("omits the artifacts row when nothing was uploaded", () => {
    const comment = renderProofComment(
      parseProofDocument({
        kind: "validation-result",
        outcome: "passed",
        summary: "The profile flow behaves as expected.",
        details: "Executed the consumer-defined validation prompt.",
      }),
      {
        issueNumber: 123,
        recordedAt: "2026-07-24T21:00:00.000Z",
        artifactLinks: [],
      },
    );

    expect(comment).not.toContain("| Artifacts |");
  });
});

describe("parseArtifactLinks", () => {
  it("reads an optional name before the URL on each line", () => {
    expect(parseArtifactLinks([
      "octestra-validation-123-attempt-1 https://github.com/o/r/actions/runs/1/artifacts/99",
      "  screen recordings   https://github.com/o/r/actions/runs/1/artifacts/100  ",
      "https://github.com/o/r/actions/runs/1/artifacts/101",
      "",
      "octestra-validation-123-attempt-1 ",
    ])).toEqual([
      {
        name: "octestra-validation-123-attempt-1",
        url: "https://github.com/o/r/actions/runs/1/artifacts/99",
      },
      { name: "screen recordings", url: "https://github.com/o/r/actions/runs/1/artifacts/100" },
      { url: "https://github.com/o/r/actions/runs/1/artifacts/101" },
    ]);
  });
});
