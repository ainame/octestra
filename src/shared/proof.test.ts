import { describe, expect, it } from "vitest";
import {
  linkArtifactReferences,
  parseArtifactLinks,
  parseProofDocument,
  renderProofComment,
  resultLabel,
  resultMark,
} from "./proof";

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
    expect(comment).toContain("| Outcome | ✅ Passed |");
    expect(comment).toContain("| AC-1 | The profile loads | ✅ | UI flow |");
    expect(comment).toContain(
      "| Goal-based UI validation | agentic E2E | AC-1 | ✅ | recording.mp4 |",
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

  it("links the run's artifact list, the download command, and every cited file", () => {
    const comment = renderProofComment(
      parseProofDocument({
        kind: "validation-result",
        outcome: "passed",
        summary: "The profile flow behaves as expected.",
        acceptance: [{
          id: "AC-1",
          criterion: "The profile loads",
          result: "passed",
          evidence: "screens/home.png / home-fullres.png; snapshot rows e75, e76.",
        }],
        checks: [{
          name: "Journey",
          result: "passed",
          evidence: "/Users/runner/work/_temp/octestra-validation-artifacts/journey.mp4",
        }],
        evidence: [
          { name: "Home screen", type: "image", reference: "./screens/home.png" },
          { name: "Log", type: "text", reference: "logs/build.log" },
        ],
        details: "Executed the consumer-defined validation prompt.",
      }),
      {
        issueNumber: 123,
        pullNumber: 42,
        runUrl: "https://github.com/ainame/octestra/actions/runs/1",
        runId: "1",
        recordedAt: "2026-07-24T21:00:00.000Z",
        artifactLinks: [
          { name: "screens/home.png", url: "https://github.com/ainame/octestra/actions/runs/1/artifacts/11" },
          { name: "home-fullres.png", url: "https://github.com/ainame/octestra/actions/runs/1/artifacts/12" },
          { name: "journey.mp4", url: "https://github.com/ainame/octestra/actions/runs/1/artifacts/13" },
        ],
      },
    );

    const artifactRow =
      "| Artifacts | [3 files](https://github.com/ainame/octestra/actions/runs/1#artifacts) |";
    expect(comment).toContain(artifactRow);
    expect(comment.indexOf(artifactRow)).toBeLessThan(
      comment.indexOf("<summary>Additional details</summary>"),
    );
    const download = [
      "Download all files from a checkout of this repository:",
      "",
      "```sh",
      ".github/octestra/octestra.sh artifacts 1",
      "```",
    ].join("\n");
    expect(comment).toContain(download);
    expect(comment.indexOf(download)).toBeLessThan(comment.indexOf("### Acceptance criteria"));
    expect(comment).toContain(
      "| AC-1 | The profile loads | ✅ | "
        + "[screens/home.png](https://github.com/ainame/octestra/actions/runs/1/artifacts/11) / "
        + "[home-fullres.png](https://github.com/ainame/octestra/actions/runs/1/artifacts/12); "
        + "snapshot rows e75, e76. |",
    );
    expect(comment).toContain(
      "| Journey | — | — | ✅ | "
        + "[/Users/runner/work/_temp/octestra-validation-artifacts/journey.mp4]"
        + "(https://github.com/ainame/octestra/actions/runs/1/artifacts/13) |",
    );
    expect(comment).toContain(
      "| Home screen | image | "
        + "[./screens/home.png](https://github.com/ainame/octestra/actions/runs/1/artifacts/11) |",
    );
    expect(comment).toContain("| Log | text | logs/build.log |");
  });

  it("lists the links themselves when there is no run to point at", () => {
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

    expect(comment).toContain(
      "| Artifacts | [octestra-validation-123-attempt-1]"
        + "(https://github.com/ainame/octestra/actions/runs/1/artifacts/99) |",
    );
    expect(comment).not.toContain("octestra.sh artifacts");
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

describe("resultMark", () => {
  it("drops the word for a recognised result and keeps it for anything else", () => {
    expect(resultMark("succeeded")).toBe("✅");
    expect(resultMark("failure")).toBe("❌");
    expect(resultMark("blocked")).toBe("⛔");
    expect(resultMark("not_run")).toBe("-");
    expect(resultMark("partial")).toBe("ℹ️ partial");
    expect(resultMark(undefined)).toBe("ℹ️ reported");
  });

  it("matches the mark resultLabel shows", () => {
    for (const result of ["passed", "failed", "blocked", "skipped", "partial"]) {
      expect(resultLabel(result).startsWith(resultMark(result))).toBe(true);
    }
  });
});

describe("linkArtifactReferences", () => {
  const links = [
    { name: "screens/home.png", url: "https://example.test/11" },
    { name: "a/dup.png", url: "https://example.test/12" },
    { name: "b/dup.png", url: "https://example.test/13" },
  ];

  it("links exact, suffix, and unique basename matches and leaves the rest alone", () => {
    expect(linkArtifactReferences("home.png then screens/home.png.", links)).toBe(
      "[home.png](https://example.test/11) then [screens/home.png](https://example.test/11).",
    );
    expect(linkArtifactReferences("(dup.png) and b/dup.png", links)).toBe(
      "(dup.png) and [b/dup.png](https://example.test/13)",
    );
    expect(linkArtifactReferences("see `screens/home.png` here", links)).toBe(
      "see [`screens/home.png`](https://example.test/11) here",
    );
    expect(linkArtifactReferences("no files here", links)).toBe("no files here");
    expect(linkArtifactReferences("screens/home.png", [])).toBe("screens/home.png");
  });

  it("links a name glued to prose and leaves longer names alone", () => {
    expect(linkArtifactReferences("home.pngを参照。", links)).toBe(
      "[home.png](https://example.test/11)を参照。",
    );
    expect(linkArtifactReferences("見出しはscreens/home.png、次にb/dup.pngで確認", links)).toBe(
      "見出しは[screens/home.png](https://example.test/11)、次に[b/dup.png](https://example.test/13)で確認",
    );
    expect(linkArtifactReferences("xhome.png home.png.bak home.pngx", links)).toBe(
      "xhome.png home.png.bak home.pngx",
    );
    expect(linkArtifactReferences(
      "/Users/runner/work/_temp/octestra-validation-artifacts/screens/home.png (before)",
      links,
    )).toBe(
      "[/Users/runner/work/_temp/octestra-validation-artifacts/screens/home.png](https://example.test/11) (before)",
    );
  });

  it("escapes file names that contain regex characters", () => {
    const odd = [{ name: "shots/final (1).png", url: "https://example.test/21" }];

    expect(linkArtifactReferences("see shots/final (1).png and final (1).png", odd)).toBe(
      "see [shots/final (1).png](https://example.test/21) and [final (1).png](https://example.test/21)",
    );
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
