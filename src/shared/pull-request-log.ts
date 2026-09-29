// The validation log is a table at the end of the task pull request's body, one row per
// validation run, so a reviewer on the pull request reaches the proof comment, the workflow
// run and the uploaded evidence without opening the issue first.

import { resultLabel } from "./proof";
import type { ValidationResult } from "./result";

export const validationLogMarker = "<!-- octestra-validation-log -->";
// GitHub rejects a pull request body longer than this.
export const maximumPullRequestBodyLength = 65536;

const validationLogHeading = "## Validation runs";
const validationLogHeader = [
  "| When (UTC) | Result | Task | Links |",
  "| --- | --- | --- | --- |",
];

export interface ValidationLogRow {
  recordedAt: Date;
  // A proof reports only these two; "Blocked" is a task status, not an outcome.
  outcome: ValidationResult["outcome"];
  issueNumber: number;
  // The proof comment on the task issue; absent when posting it returned no URL.
  proofUrl?: string;
  runUrl: string;
  artifactCount: number;
}

function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

// Link text stays short and the issue is `#number`, so GitHub neither widens the row with
// URLs nor expands a bare issue URL into its title.
export function renderValidationLogRow(row: ValidationLogRow): string {
  const links = [
    row.proofUrl ? `[proof](${row.proofUrl})` : undefined,
    `[run](${row.runUrl})`,
    row.artifactCount > 0
      ? `[${row.artifactCount} ${row.artifactCount === 1 ? "file" : "files"}](${row.runUrl}#artifacts)`
      : undefined,
  ].filter((link): link is string => link !== undefined);
  return `| ${utcMinute(row.recordedAt)} | ${resultLabel(row.outcome)} | #${row.issueNumber} | ${links.join(" · ")} |`;
}

// The first run writes the marker, the heading and the table header after whatever the body
// holds; later runs insert one row after the last row of that table, so text a person adds
// below the table stays below it. The marker only counts on a line of its own directly above
// the heading, so a body that merely quotes it, say in a code block, gets a real table.
export function appendValidationLogRow(body: string, row: string): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const markerIndex = lines.findIndex((line, index) =>
    line.trim() === validationLogMarker && lines[index + 1]?.trim() === validationLogHeading,
  );
  if (markerIndex === -1) {
    const trimmed = lines.join("\n");
    const section = [validationLogMarker, validationLogHeading, "", ...validationLogHeader, row];
    return `${trimmed}${trimmed ? "\n\n" : ""}${section.join("\n")}\n`;
  }
  let tableStart = markerIndex + 2;
  while (tableStart < lines.length && !lines[tableStart].startsWith("|")) {
    tableStart += 1;
  }
  if (tableStart === lines.length) {
    // The heading survived but the table did not: start it again under the heading.
    lines.splice(markerIndex + 2, 0, "", ...validationLogHeader, row);
    return `${lines.join("\n")}\n`;
  }
  let tableEnd = tableStart;
  while (tableEnd < lines.length && lines[tableEnd].startsWith("|")) {
    tableEnd += 1;
  }
  lines.splice(tableEnd, 0, row);
  return `${lines.join("\n")}\n`;
}
