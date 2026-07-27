import { readFile } from "node:fs/promises";

type ProofRow = Record<string, unknown>;

export interface ProofDocument {
  outcome: string;
  summary: string;
  nextStatus?: string;
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

  // This is a rendering convention rather than a lifecycle contract. Validate the
  // fields the renderer understands and deliberately ignore consumer extensions.
  const proof = raw as Record<string, unknown>;
  return {
    outcome: requireString(proof.outcome, "outcome", true)!,
    summary: requireString(proof.summary, "summary", true)!,
    nextStatus: requireString(proof.next_status ?? proof.nextStatus, "next_status"),
    details: requireString(proof.details, "details"),
    acceptance: optionalRows(proof.acceptance, "acceptance"),
    checks: optionalRows(proof.checks, "checks"),
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

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function renderAcceptance(rows: ProofRow[]): string {
  return markdownTable(
    ["ID", "Criterion", "Result", "Evidence"],
    rows.map((row, index) => [
      tableCell(valueFrom(row, "id"), `AC-${index + 1}`),
      tableCell(valueFrom(row, "criterion", "description", "name", "summary")),
      tableCell(resultLabel(valueFrom(row, "result", "outcome", "status"))),
      tableCell(valueFrom(row, "evidence", "evidenceRefs", "evidence_refs")),
    ]),
  );
}

function renderChecks(rows: ProofRow[]): string {
  return markdownTable(
    ["Check", "Type", "Scope", "Result", "Evidence"],
    rows.map((row, index) => [
      tableCell(valueFrom(row, "name", "id"), `Check ${index + 1}`),
      tableCell(valueFrom(row, "type", "kind")),
      tableCell(valueFrom(row, "scope")),
      tableCell(resultLabel(valueFrom(row, "result", "outcome", "status"))),
      tableCell(valueFrom(row, "evidence", "evidenceRefs", "evidence_refs")),
    ]),
  );
}

function renderEvidence(rows: ProofRow[]): string {
  return markdownTable(
    ["Evidence", "Type", "Reference"],
    rows.map((row, index) => [
      tableCell(valueFrom(row, "name", "id"), `Evidence ${index + 1}`),
      tableCell(valueFrom(row, "type", "kind")),
      tableCell(valueFrom(row, "reference", "url", "link", "path")),
    ]),
  );
}

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
    sections.push("", "### Acceptance criteria", "", renderAcceptance(proof.acceptance));
  }
  if (proof.checks?.length) {
    sections.push("", "### Checks", "", renderChecks(proof.checks));
  }
  if (evidence.length) {
    sections.push("", "### Evidence", "", renderEvidence(evidence));
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
