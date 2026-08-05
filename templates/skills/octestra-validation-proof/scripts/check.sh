#!/usr/bin/env bash

# Validates the JSON result written by a validation agent.

set -euo pipefail

if (( $# != 1 )); then
  printf 'Usage: %s RESULT_PATH\n' "$0" >&2
  exit 2
fi

result_path="$1"

if [[ ! -f "$result_path" ]]; then
  printf 'Octestra: error: validation result does not exist: %s\n' "$result_path" >&2
  exit 1
fi

node - "$result_path" <<'NODE'
const { readFileSync } = require("node:fs");

const resultPath = process.argv[2];

function fail(message) {
  console.error(`Octestra: error: ${message}`);
  process.exit(1);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`validation result ${field} must be a non-empty string`);
  }
}

function requireChecks(value) {
  if (!Array.isArray(value) || value.some((row) =>
    typeof row !== "object" || row === null || Array.isArray(row)
  )) {
    fail("validation result checks must be an array of objects");
  }
}

let result;
try {
  result = JSON.parse(readFileSync(resultPath, "utf8"));
} catch (error) {
  fail(`could not parse validation result: ${error.message}`);
}

if (typeof result !== "object" || result === null || Array.isArray(result)) {
  fail("validation result must be a JSON object");
}

requireString(result.outcome, "outcome");
requireString(result.summary, "summary");

if (result.checks !== undefined) {
  requireChecks(result.checks);
  result.checks.forEach((check, index) => {
    requireString(check.name, `checks[${index}].name`);
    requireString(check.result, `checks[${index}].result`);
  });
}

console.log(`Octestra: validation result is valid: ${resultPath}`);
NODE
