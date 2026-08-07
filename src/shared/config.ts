import { parse } from "yaml";

export interface OctestraConfig {
  version: 1;
  github_app: { client_id: string };
  runners: { orchestration: string; agent: string };
  status: { field_name: string; field_id: number };
  branch: { task: string };
  prompts: { lifecycle_in_progress: string; lifecycle_validation: string };
}
export interface ConfigClient { getContent(path: string, ref?: string): Promise<string>; }
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
    prompts: { lifecycle_in_progress: requiredString(prompts.lifecycle_in_progress, "prompts.lifecycle_in_progress"), lifecycle_validation: requiredString(prompts.lifecycle_validation, "prompts.lifecycle_validation") },
  };
}
export async function loadOctestraConfig(client: ConfigClient, ref?: string): Promise<OctestraConfig> {
  return parseOctestraConfig(await client.getContent(".github/octestra/config.yml", ref || undefined));
}
