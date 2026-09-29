import { parse } from "yaml";

// Minutes each agent phase may run before its step is stopped. The job that runs the phase
// gets `jobTimeoutOverheadMinutes` more for preparation, upload and finalization.
export interface AgentTimeouts {
  task: number;
  validation: number;
  triage: number;
}

export interface OctestraConfig {
  version: 1;
  github_app: { client_id: string };
  runners: { orchestration: string; agent: string };
  status: { field_name: string; field_id: number };
  branch: { task: string };
  prompts: {
    lifecycle_in_progress: string;
    lifecycle_validation: string;
    loop_todo: string;
  };
  agent_timeout_minutes: AgentTimeouts;
  // Whether finalize-validation keeps a table of validation runs at the end of the task pull
  // request's body.
  append_validation_result_to_pr_body: boolean;
}

// Fifty minutes of agent inside the sixty-minute jobs the templates always had.
export const defaultAgentTimeoutMinutes = 50;
export const jobTimeoutOverheadMinutes = 10;
// GitHub stops a job at 360 minutes; the overhead must fit under that.
export const maximumAgentTimeoutMinutes = 360 - jobTimeoutOverheadMinutes;

export const defaultAgentTimeouts: AgentTimeouts = {
  task: defaultAgentTimeoutMinutes,
  validation: defaultAgentTimeoutMinutes,
  triage: defaultAgentTimeoutMinutes,
};

export function jobTimeoutMinutes(agentTimeoutMinutes: number): number {
  return agentTimeoutMinutes + jobTimeoutOverheadMinutes;
}
export interface ConfigClient { getContent(path: string, ref?: string): Promise<string>; }
const defaultLoopTodoPrompt = ".github/octestra/prompts/loop-todo.md.hbs";
function mapping(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`config.yml ${name} must be a mapping`);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`config.yml ${name} must be a non-empty string`);
  return value.trim();
}
function requiredPositiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`config.yml ${name} must be a positive integer`);
  }
  return number;
}
// A number, or a string of digits as field_id is written; true, null, 7.5 or "8h" is a mistake
// to report, not coerce. The installed doctor applies the same rule.
function optionalTimeoutMinutes(value: unknown, name: string): number {
  if (value === undefined) {
    return defaultAgentTimeoutMinutes;
  }
  const minutes = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof minutes !== "number"
    || !Number.isInteger(minutes)
    || minutes < 1
    || minutes > maximumAgentTimeoutMinutes
  ) {
    throw new Error(
      `config.yml ${name} must be a whole number of minutes from 1 to ${maximumAgentTimeoutMinutes}`,
    );
  }
  return minutes;
}

// A missing section and an empty one (`agent_timeout_minutes:` with nothing under it, which
// YAML reads as null) both mean "the defaults": nothing was specified either way.
function agentTimeouts(value: unknown): AgentTimeouts {
  if (value === undefined || value === null) {
    return { ...defaultAgentTimeouts };
  }
  const section = mapping(value, "agent_timeout_minutes");
  return {
    task: optionalTimeoutMinutes(section.task, "agent_timeout_minutes.task"),
    validation: optionalTimeoutMinutes(section.validation, "agent_timeout_minutes.validation"),
    triage: optionalTimeoutMinutes(section.triage, "agent_timeout_minutes.triage"),
  };
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`config.yml ${name} must be true or false`);
  }
  return value;
}

export function parseOctestraConfig(raw: string): OctestraConfig {
  const root = mapping(parse(raw), "root");
  if (root.version !== 1) throw new Error("config.yml version must be 1");
  const app = mapping(root.github_app, "github_app");
  const runners = mapping(root.runners, "runners");
  const status = mapping(root.status, "status");
  const branch = mapping(root.branch, "branch");
  const prompts = mapping(root.prompts, "prompts");
  return {
    version: 1,
    github_app: { client_id: requiredString(app.client_id, "github_app.client_id") },
    runners: { orchestration: requiredString(runners.orchestration, "runners.orchestration"), agent: requiredString(runners.agent, "runners.agent") },
    status: {
      field_name: requiredString(status.field_name, "status.field_name"),
      field_id: requiredPositiveInteger(status.field_id, "status.field_id"),
    },
    branch: { task: requiredString(branch.task, "branch.task") },
    prompts: {
      lifecycle_in_progress: requiredString(
        prompts.lifecycle_in_progress,
        "prompts.lifecycle_in_progress",
      ),
      lifecycle_validation: requiredString(
        prompts.lifecycle_validation,
        "prompts.lifecycle_validation",
      ),
      loop_todo: prompts.loop_todo === undefined
        ? defaultLoopTodoPrompt
        : requiredString(prompts.loop_todo, "prompts.loop_todo"),
    },
    agent_timeout_minutes: agentTimeouts(root.agent_timeout_minutes),
    append_validation_result_to_pr_body: optionalBoolean(
      root.append_validation_result_to_pr_body,
      "append_validation_result_to_pr_body",
      true,
    ),
  };
}
export async function loadOctestraConfig(client: ConfigClient, ref?: string): Promise<OctestraConfig> {
  return parseOctestraConfig(await client.getContent(".github/octestra/config.yml", ref || undefined));
}
