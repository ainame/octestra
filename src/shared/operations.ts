import * as core from "@actions/core";

export function normalizeAgentDebugFlag(value: string): void {
  core.exportVariable("OCTESTRA_AGENT_DEBUG", value === "true" ? "true" : "false");
}
