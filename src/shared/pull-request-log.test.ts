import { describe, expect, it } from "vitest";
import {
  appendValidationLogRow,
  renderValidationLogRow,
  validationLogMarker,
} from "./pull-request-log";

const runUrl = "https://github.com/example-org/consumer/actions/runs/123456";

describe("renderValidationLogRow", () => {
  it("renders the time to the minute, the result, the task and short links", () => {
    expect(renderValidationLogRow({
      recordedAt: new Date("2026-09-29T15:20:33.000Z"),
      outcome: "passed",
      issueNumber: 42,
      proofUrl: "https://github.com/example-org/consumer/issues/42#issuecomment-7",
      runUrl,
      artifactCount: 15,
    })).toBe(
      "| 2026-09-29 15:20 | ✅ Passed | #42 | "
        + "[proof](https://github.com/example-org/consumer/issues/42#issuecomment-7) · "
        + `[run](${runUrl}) · [15 files](${runUrl}#artifacts) |`,
    );
  });

  it("drops the proof and artifacts links when there is nothing to link", () => {
    expect(renderValidationLogRow({
      recordedAt: new Date("2026-09-29T15:20:33.000Z"),
      outcome: "blocked",
      issueNumber: 42,
      runUrl,
      artifactCount: 0,
    })).toBe(`| 2026-09-29 15:20 | ⛔ Blocked | #42 | [run](${runUrl}) |`);
  });

  it("uses the singular for one file", () => {
    expect(renderValidationLogRow({
      recordedAt: new Date("2026-09-29T15:20:33.000Z"),
      outcome: "failed",
      issueNumber: 42,
      runUrl,
      artifactCount: 1,
    })).toContain(`[1 file](${runUrl}#artifacts)`);
  });
});

describe("appendValidationLogRow", () => {
  const row = "| 2026-09-29 15:20 | ✅ Passed | #42 | [run](https://example.test/1) |";

  it("adds the marker, heading and header after the existing body on the first run", () => {
    expect(appendValidationLogRow("## Summary\n\nExisting body.\n\n\n", row)).toBe([
      "## Summary",
      "",
      "Existing body.",
      "",
      validationLogMarker,
      "## Validation runs",
      "",
      "| When (UTC) | Result | Task | Links |",
      "| --- | --- | --- | --- |",
      row,
      "",
    ].join("\n"));
  });

  it("starts the table at the top of an empty body", () => {
    expect(appendValidationLogRow("", row).startsWith(`${validationLogMarker}\n## Validation runs`)).toBe(true);
  });

  it("appends only the row when the table is already there", () => {
    const first = appendValidationLogRow("Body", row);
    const second = appendValidationLogRow(first, row.replace("Passed", "Passed again"));

    expect(second.split(validationLogMarker)).toHaveLength(2);
    expect(second.endsWith(`${row}\n${row.replace("Passed", "Passed again")}\n`)).toBe(true);
  });

  it("inserts the row into the table when text follows it", () => {
    const withNote = `${appendValidationLogRow("Body", row)}\nA note the reviewer left below the table.\n`;

    expect(appendValidationLogRow(withNote, row.replace("15:20", "16:00"))).toBe([
      "Body",
      "",
      validationLogMarker,
      "## Validation runs",
      "",
      "| When (UTC) | Result | Task | Links |",
      "| --- | --- | --- | --- |",
      row,
      row.replace("15:20", "16:00"),
      "",
      "A note the reviewer left below the table.",
      "",
    ].join("\n"));
  });

  it("ignores a quoted marker and starts a real table", () => {
    const quoted = "Docs:\n\n```\n<!-- octestra-validation-log -->\n```\n";

    const result = appendValidationLogRow(quoted, row);

    expect(result.split(validationLogMarker)).toHaveLength(3);
    expect(result).toContain("| When (UTC) | Result | Task | Links |");
  });

  it("rebuilds the table under a heading whose table was deleted", () => {
    const headingOnly = `${validationLogMarker}\n## Validation runs\n`;

    expect(appendValidationLogRow(headingOnly, row)).toBe([
      validationLogMarker,
      "## Validation runs",
      "",
      "| When (UTC) | Result | Task | Links |",
      "| --- | --- | --- | --- |",
      row,
      "",
    ].join("\n"));
  });
});
