// The validation log is a table at the end of the task pull request's body, one row per
// validation run, so a reviewer on the pull request reaches the proof comment, the workflow
// run and the uploaded evidence without opening the issue first.

export const validationLogMarker = "<!-- octestra-validation-log -->";

const validationLogHeading = "## Validation runs";
const validationLogHeader = [
  "| When (UTC) | Result | Task | Links |",
  "| --- | --- | --- | --- |",
];

export interface ValidationLogRow {
  recordedAt: Date;
  outcome: string;
  issueNumber: number;
  // The proof comment on the task issue; absent when posting it returned no URL.
  proofUrl?: string;
  runUrl: string;
  artifactCount: number;
}

function resultLabel(outcome: string): string {
  switch (outcome) {
    case "passed":
      return "✅ passed";
    case "failed":
      return "❌ failed";
    default:
      return `ℹ️ ${outcome}`;
  }
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
// holds; later runs append one row. The table therefore has to stay the last thing in the
// body, and text a person adds below it ends up above the next row.
export function appendValidationLogRow(body: string, row: string): string {
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.includes(validationLogMarker)) {
    return `${trimmed}\n${row}\n`;
  }
  const section = [validationLogMarker, validationLogHeading, "", ...validationLogHeader, row];
  return `${trimmed}${trimmed ? "\n\n" : ""}${section.join("\n")}\n`;
}
