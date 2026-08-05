import { readFile } from "node:fs/promises";
import { markdownTable } from "./markdown";

type ProofRow = Record<string, unknown>;

export interface ProofDocument {
  outcome: string;
  summary: string;
  details?: string;
  acceptance?: ProofRow[];
  checks?: ProofRow[];
  evidence?: ProofRow[];
  artifacts?: ProofRow[];
  knownGaps?: string[];
}

export interface ProofCommentContext {
  issueNumber: number;
  pullNumber?: number;
  subjectSha?: string;
  owner?: string;
  actor?: string;
  runUrl?: string;
  runAttempt?: string;
  recordedAt?: string;
}

function requireString(
  value: unknown,
  field: string,
  required = false,
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Proof ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalRows(value: unknown, field: string): ProofRow[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((row) =>
    typeof row !== "object" || row === null || Array.isArray(row)
  )) {
    throw new Error(`Proof ${field} must be an array of objects`);
  }
  return value as ProofRow[];
}

function optionalChecks(value: unknown): ProofRow[] | undefined {
  const checks = optionalRows(value, "checks");

  if (checks === undefined) {
    return undefined;
  }

  checks.forEach((check, index) => {
    requireString(check.name, `checks[${index}].name`, true);
    requireString(check.result, `checks[${index}].result`, true);
  });
  return checks;
}

function optionalStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Proof ${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function parseProofDocument(raw: unknown): ProofDocument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Proof must be a JSON object");
  }

  // The top-level outcome controls the lifecycle. Checks have a small structural
  // contract for readable proof comments; consumer-specific fields remain allowed.
  const proof = raw as Record<string, unknown>;
  return {
    outcome: requireString(proof.outcome, "outcome", true)!,
    summary: requireString(proof.summary, "summary", true)!,
    details: requireString(proof.details, "details"),
    acceptance: optionalRows(proof.acceptance, "acceptance"),
    checks: optionalChecks(proof.checks),
    evidence: optionalRows(proof.evidence, "evidence"),
    artifacts: optionalRows(proof.artifacts, "artifacts"),
    knownGaps: optionalStrings(
      proof.knownGaps ?? proof.known_gaps,
      "knownGaps",
    ),
  };
}

export async function readProofDocument(proofPath: string): Promise<ProofDocument> {
  return parseProofDocument(JSON.parse(await readFile(proofPath, "utf8")));
}

function valueFrom(row: ProofRow, ...keys: string[]): unknown {
  return keys.map((key) => row[key]).find((value) => value !== undefined);
}

function displayValue(value: unknown, fallback = "—"): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => displayValue(item, "")).filter(Boolean);
    return items.length > 0 ? items.join(", ") : fallback;
  }
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function tableCell(value: unknown, fallback = "—"): string {
  return displayValue(value, fallback)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function resultLabel(value: unknown): string {
  const result = displayValue(value, "reported");
  switch (result.toLowerCase()) {
    case "passed":
    case "success":
    case "succeeded":
      return "✅ Passed";
    case "failed":
    case "failure":
      return "❌ Failed";
    case "blocked":
      return "⛔ Blocked";
    case "skipped":
    case "not_run":
    case "not run":
      return "⏭️ Skipped";
    default:
      return `ℹ️ ${result}`;
  }
}

// A column is a header plus the row keys it reads, most-preferred key first.
// `fallback` supplies a positional label when a row names nothing usable, and
// `label` marks the columns whose value is a pass/fail result rather than text.
interface ProofColumn {
  header: string;
  keys: string[];
  fallback?: (index: number) => string;
  label?: boolean;
}

function renderProofRows(columns: ProofColumn[], rows: ProofRow[]): string {
  return markdownTable(
    columns.map((column) => column.header),
    rows.map((row, index) => columns.map((column) => {
      const value = valueFrom(row, ...column.keys);
      if (column.label) {
        return tableCell(resultLabel(value));
      }
      return tableCell(value, column.fallback?.(index));
    })),
  );
}

const acceptanceColumns: ProofColumn[] = [
  { header: "ID", keys: ["id"], fallback: (index) => `AC-${index + 1}` },
  { header: "Criterion", keys: ["criterion", "description", "name", "summary"] },
  { header: "Result", keys: ["result", "outcome", "status"], label: true },
  { header: "Evidence", keys: ["evidence", "evidenceRefs", "evidence_refs"] },
];

const checkColumns: ProofColumn[] = [
  { header: "Check", keys: ["name", "id"], fallback: (index) => `Check ${index + 1}` },
  { header: "Type", keys: ["type", "kind"] },
  { header: "Scope", keys: ["scope"] },
  { header: "Result", keys: ["result", "outcome", "status"], label: true },
  { header: "Evidence", keys: ["evidence", "evidenceRefs", "evidence_refs"] },
];

const evidenceColumns: ProofColumn[] = [
  { header: "Evidence", keys: ["name", "id"], fallback: (index) => `Evidence ${index + 1}` },
  { header: "Type", keys: ["type", "kind"] },
  { header: "Reference", keys: ["reference", "url", "link", "path"] },
];

export function renderProofComment(
  proof: ProofDocument,
  context: ProofCommentContext,
): string {
  // Reviewers see the result and evidence first. Execution metadata remains available
  // for auditing without making the default comment difficult to scan.
  const overviewRows = [
    context.pullNumber ? ["Pull request", `#${context.pullNumber}`] : undefined,
    context.subjectSha
      ? ["Validated commit", `\`${tableCell(context.subjectSha.slice(0, 12))}\``]
      : undefined,
    ["Outcome", resultLabel(proof.outcome)],
    proof.knownGaps
      ? ["Known gaps", proof.knownGaps.length === 0 ? "None" : String(proof.knownGaps.length)]
      : undefined,
  ].filter((row): row is string[] => row !== undefined);
  const evidence = [...(proof.evidence ?? []), ...(proof.artifacts ?? [])];
  const metadataRows = [
    ["Issue", `#${context.issueNumber}`],
    context.pullNumber ? ["Pull request", `#${context.pullNumber}`] : undefined,
    context.subjectSha ? ["Subject SHA", `\`${tableCell(context.subjectSha)}\``] : undefined,
    context.runUrl ? ["Workflow run", `[View run](${context.runUrl})`] : undefined,
    context.runAttempt ? ["Run attempt", tableCell(context.runAttempt)] : undefined,
    context.actor ? ["Actor", `@${tableCell(context.actor)}`] : undefined,
    ["Task owner", context.owner ? `@${tableCell(context.owner)}` : "Unassigned"],
    ["Recorded at", tableCell(context.recordedAt ?? new Date().toISOString())],
  ].filter((row): row is string[] => row !== undefined);

  const sections = [
    "<!-- octestra-proof-of-work -->",
    `## ${resultLabel(proof.outcome)} validation proof`,
    "",
    proof.summary,
    "",
    markdownTable(["Target", "Result"], overviewRows),
  ];

  if (proof.acceptance?.length) {
    sections.push("", "### Acceptance criteria", "", renderProofRows(acceptanceColumns, proof.acceptance));
  }
  if (proof.checks?.length) {
    sections.push("", "### Checks", "", renderProofRows(checkColumns, proof.checks));
  }
  if (evidence.length) {
    sections.push("", "### Evidence", "", renderProofRows(evidenceColumns, evidence));
  }
  if (proof.knownGaps?.length) {
    sections.push(
      "",
      "### Known gaps",
      "",
      proof.knownGaps.map((gap) => `- ${gap}`).join("\n"),
    );
  }
  if (proof.details) {
    sections.push(
      "",
      "<details>",
      "<summary>Additional details</summary>",
      "",
      proof.details,
      "",
      "</details>",
    );
  }

  sections.push(
    "",
    "<details>",
    "<summary>Technical metadata</summary>",
    "",
    markdownTable(["Field", "Value"], metadataRows),
    "",
    "</details>",
  );
  return sections.join("\n");
}
