#!/usr/bin/env bash

# Validates JSON results written by Octestra triage and validation agents.

set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  printf 'Usage: %s PHASE RESULT_PATH [ARTIFACT_PATH]\n' "$0" >&2
  exit 2
fi

phase="$1"
result_path="$2"
# Validation only: the directory the evidence was saved in, so file references can be checked.
artifact_path="${3:-}"

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

node - "$phase" "$result_path" "$artifact_path" <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const phase = process.argv[2];
const resultPath = process.argv[3];
const artifactPath = process.argv[4];

function fail(message) {
  console.error(`Octestra: error: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.error(`Octestra: warning: ${message}`);
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

// Every file under the artifact directory is uploaded after the run, and a reference that
// names it by its path relative to that directory becomes a link in the result comment. An
// absolute path is the mistake agents actually make, so it is an error: with the fix spelled
// out when it points into the artifact directory, and as a plain rejection when it points
// anywhere else, since nothing outside that directory is uploaded. A relative name that matches
// no saved file may still be prose, so it is only a warning.
const evidenceExtensions = /\.(png|jpe?g|gif|webp|mp4|mov|webm|txt|log|json|md|html?)$/i;

function referenceStrings(row) {
  const strings = [];
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string") {
      strings.push({ key, value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string") {
          strings.push({ key: `${key}[${index}]`, value: item });
        }
      });
    }
  }
  return strings;
}

function checkFileReferences(result, directory) {
  const absolutePrefix = `${directory}${path.sep}`;
  for (const field of ["acceptance", "checks", "evidence", "artifacts"]) {
    (result[field] ?? []).forEach((row, index) => {
      for (const { key, value } of referenceStrings(row)) {
        const where = `${field}[${index}].${key}`;
        if (value.includes(absolutePrefix)) {
          fail(
            `validation result ${where} names a file by absolute path; ` +
            `write it relative to the artifact directory, for example ` +
            `"${value.slice(value.indexOf(absolutePrefix) + absolutePrefix.length).split(/[\s,;()`]/)[0]}"`,
          );
        }
        for (const token of value.split(/[\s,;()`]+/)) {
          if (!evidenceExtensions.test(token)) {
            continue;
          }
          if (path.isAbsolute(token)) {
            fail(
              `validation result ${where} names ${token} by absolute path; ` +
              `save the file under the artifact directory and write its path relative to it`,
            );
          }
          if (!existsSync(path.join(directory, token))) {
            warn(`${where} names ${token}, which is not under ${directory}; it will not be linked`);
          }
        }
      }
    });
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
  if (artifactPath) {
    checkFileReferences(result, path.resolve(artifactPath));
  }
}

console.log(`Octestra: ${phase} result is valid: ${resultPath}`);
NODE
