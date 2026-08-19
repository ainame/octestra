import { readFile } from "node:fs/promises";

export type ResultRow = Record<string, unknown>;

export interface ValidationResult {
  kind: "validation-result";
  outcome: "passed" | "failed";
  summary: string;
  details?: string;
  acceptance?: ResultRow[];
  checks?: ResultRow[];
  evidence?: ResultRow[];
  artifacts?: ResultRow[];
  knownGaps?: string[];
}

export interface TriageResult {
  kind: "triage-result";
  readyIssues: number[];
  summary?: string;
}

function requireObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
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
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalRows(
  value: unknown,
  field: string,
): ResultRow[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((row) =>
    typeof row !== "object" || row === null || Array.isArray(row)
  )) {
    throw new Error(`${field} must be an array of objects`);
  }
  return value as ResultRow[];
}

function optionalChecks(value: unknown): ResultRow[] | undefined {
  const checks = optionalRows(value, "Validation result checks");
  if (checks === undefined) {
    return undefined;
  }
  checks.forEach((check, index) => {
    requireString(
      check.name,
      `Validation result checks[${index}].name`,
      true,
    );
    requireString(
      check.result,
      `Validation result checks[${index}].result`,
      true,
    );
  });
  return checks;
}

function optionalStrings(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function parseValidationResult(raw: unknown): ValidationResult {
  const result = requireObject(raw, "Validation result");
  if (result.kind !== "validation-result") {
    throw new Error("Validation result kind must be validation-result");
  }
  if (result.outcome !== "passed" && result.outcome !== "failed") {
    throw new Error("Validation result outcome must be passed or failed");
  }

  return {
    kind: "validation-result",
    outcome: result.outcome,
    summary: requireString(
      result.summary,
      "Validation result summary",
      true,
    )!,
    details: requireString(
      result.details,
      "Validation result details",
    ),
    acceptance: optionalRows(
      result.acceptance,
      "Validation result acceptance",
    ),
    checks: optionalChecks(result.checks),
    evidence: optionalRows(
      result.evidence,
      "Validation result evidence",
    ),
    artifacts: optionalRows(
      result.artifacts,
      "Validation result artifacts",
    ),
    knownGaps: optionalStrings(
      result.knownGaps ?? result.known_gaps,
      "Validation result knownGaps",
    ),
  };
}

export function parseTriageResult(raw: unknown): TriageResult {
  const result = requireObject(raw, "Triage result");
  if (result.kind !== "triage-result") {
    throw new Error("Triage result kind must be triage-result");
  }
  if (!Array.isArray(result.readyIssues)) {
    throw new Error("Triage result readyIssues must be an array");
  }

  const readyIssues = result.readyIssues.map((issueNumber, index) => {
    if (
      typeof issueNumber !== "number" ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      throw new Error(
        `Triage result readyIssues[${index}] must be a positive issue number`,
      );
    }
    return issueNumber;
  });
  if (new Set(readyIssues).size !== readyIssues.length) {
    throw new Error("Triage result readyIssues must not contain duplicates");
  }

  return {
    kind: "triage-result",
    readyIssues,
    summary: requireString(
      result.summary,
      "Triage result summary",
    ),
  };
}

export async function readJsonResult(resultPath: string): Promise<unknown> {
  return JSON.parse(await readFile(resultPath, "utf8"));
}
