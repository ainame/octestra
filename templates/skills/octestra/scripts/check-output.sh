#!/usr/bin/env bash

# Validates JSON results written by Octestra triage and validation agents.

set -euo pipefail

if (( $# != 2 )); then
  printf 'Usage: %s PHASE RESULT_PATH\n' "$0" >&2
  exit 2
fi

phase="$1"
result_path="$2"

case "$phase" in
  triage|validation) ;;
  *)
    printf 'Octestra: error: phase must be triage or validation\n' >&2
    exit 2
    ;;
esac

if [[ ! -f "$result_path" ]]; then
  printf 'Octestra: error: %s result does not exist: %s\n' "$phase" "$result_path" >&2
  exit 1
fi

node - "$phase" "$result_path" <<'NODE'
const { readFileSync } = require("node:fs");

const phase = process.argv[2];
const resultPath = process.argv[3];

function fail(message) {
  console.error(`Octestra: error: ${message}`);
  process.exit(1);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${phase} result ${field} must be a non-empty string`);
  }
}

function requireObjectRows(value, field) {
  if (!Array.isArray(value) || value.some((row) =>
    typeof row !== "object" || row === null || Array.isArray(row)
  )) {
    fail(`${phase} result ${field} must be an array of objects`);
  }
}

let result;
try {
  result = JSON.parse(readFileSync(resultPath, "utf8"));
} catch (error) {
  fail(`could not parse ${phase} result: ${error.message}`);
}

if (typeof result !== "object" || result === null || Array.isArray(result)) {
  fail(`${phase} result must be a JSON object`);
}

if (phase === "triage") {
  if (result.kind !== "triage-result") {
    fail("triage result kind must be triage-result");
  }
  if (!Array.isArray(result.readyIssues)) {
    fail("triage result readyIssues must be an array");
  }
  result.readyIssues.forEach((issueNumber, index) => {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      fail(`triage result readyIssues[${index}] must be a positive issue number`);
    }
  });
  if (new Set(result.readyIssues).size !== result.readyIssues.length) {
    fail("triage result readyIssues must not contain duplicates");
  }
  if (result.summary !== undefined) {
    requireString(result.summary, "summary");
  }
} else {
  if (result.kind !== "validation-result") {
    fail("validation result kind must be validation-result");
  }
  if (result.outcome !== "passed" && result.outcome !== "failed") {
    fail("validation result outcome must be passed or failed");
  }
  requireString(result.summary, "summary");
  for (const field of ["acceptance", "checks", "evidence", "artifacts"]) {
    if (result[field] !== undefined) {
      requireObjectRows(result[field], field);
    }
  }
  if (result.checks !== undefined) {
    result.checks.forEach((check, index) => {
      requireString(check.name, `checks[${index}].name`);
      requireString(check.result, `checks[${index}].result`);
    });
  }
  const knownGaps = result.knownGaps ?? result.known_gaps;
  if (
    knownGaps !== undefined &&
    (!Array.isArray(knownGaps) || knownGaps.some((gap) => typeof gap !== "string"))
  ) {
    fail("validation result knownGaps must be an array of strings");
  }
  if (result.details !== undefined) {
    requireString(result.details, "details");
  }
}

console.log(`Octestra: ${phase} result is valid: ${resultPath}`);
NODE
