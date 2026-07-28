import { parse } from "yaml";

export interface LoopSelectConfig {
  epic: number | null;
  status: string;
  labels: string[];
  updated_before?: number;
  limit: number;
  scan_budget: number;
  order: "oldest" | "newest";
}
export interface LoopConfig {
  prompt: string;
  select: LoopSelectConfig;
  apply: { allowed_status: string[]; assign_owner: boolean; dry_run: boolean };
  report_issue: number | null;
}
export interface OctestraConfig {
  version: 1;
  github_app: { client_id: string };
  runners: { orchestration: string; agent: string };
  status: { field_name: string; field_id: string; options: Record<string, string> };
  branch: { task: string; loop: string };
  prompts: { lifecycle_in_progress: string; lifecycle_validation: string };
  loops: Record<string, LoopConfig>;
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
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`config.yml ${name} must be a positive integer`);
  return value as number;
}
function durationSeconds(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const match = requiredString(value, name).match(/^(\d+)([smhdw])$/);
  if (!match) throw new Error(`config.yml ${name} must be a duration such as 24h`);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]]!;
  return Number(match[1]) * multiplier;
}
export function parseOctestraConfig(raw: string): OctestraConfig {
  const root = mapping(parse(raw), "root");
  if (root.version !== 1) throw new Error("config.yml version must be 1");
  const app = mapping(root.github_app, "github_app");
  const runners = mapping(root.runners, "runners");
  const status = mapping(root.status, "status");
  const options = mapping(status.options, "status.options");
  const branch = mapping(root.branch, "branch");
  const prompts = mapping(root.prompts, "prompts");
  for (const key of ["todo", "ready", "in_progress", "validation", "human_review", "blocked", "done"]) requiredString(options[key], `status.options.${key}`);
  const loops: Record<string, LoopConfig> = {};
  for (const [id, rawLoop] of Object.entries(mapping(root.loops ?? {}, "loops"))) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`config.yml loops.${id} must use a lowercase slug`);
    const loop = mapping(rawLoop, `loops.${id}`);
    const select = mapping(loop.select, `loops.${id}.select`);
    const apply = mapping(loop.apply, `loops.${id}.apply`);
    const labels = select.labels ?? [];
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label.trim())) throw new Error(`config.yml loops.${id}.select.labels must be strings`);
    const epic = select.epic ?? null;
    if (epic !== null) positiveInteger(epic, `loops.${id}.select.epic`);
    if (epic === null && labels.length === 0) throw new Error(`config.yml loops.${id} must set select.epic or select.labels`);
    const order = select.order ?? "oldest";
    if (order !== "oldest" && order !== "newest") throw new Error(`config.yml loops.${id}.select.order must be oldest or newest`);
    if (!Array.isArray(apply.allowed_status) || apply.allowed_status.some((candidate) => typeof candidate !== "string" || !candidate.trim())) throw new Error(`config.yml loops.${id}.apply.allowed_status must be strings`);
    if (typeof apply.assign_owner !== "boolean" || typeof apply.dry_run !== "boolean") throw new Error(`config.yml loops.${id}.apply assign_owner and dry_run must be booleans`);
    loops[id] = {
      prompt: requiredString(loop.prompt, `loops.${id}.prompt`),
      select: { epic: epic as number | null, status: requiredString(select.status, `loops.${id}.select.status`), labels, updated_before: durationSeconds(select.updated_before, `loops.${id}.select.updated_before`), limit: positiveInteger(select.limit, `loops.${id}.select.limit`), scan_budget: positiveInteger(select.scan_budget, `loops.${id}.select.scan_budget`), order },
      apply: { allowed_status: apply.allowed_status as string[], assign_owner: apply.assign_owner as boolean, dry_run: apply.dry_run as boolean },
      report_issue: loop.report_issue == null ? null : positiveInteger(loop.report_issue, `loops.${id}.report_issue`),
    };
  }
  return {
    version: 1,
    github_app: { client_id: requiredString(app.client_id, "github_app.client_id") },
    runners: { orchestration: requiredString(runners.orchestration, "runners.orchestration"), agent: requiredString(runners.agent, "runners.agent") },
    status: { field_name: requiredString(status.field_name, "status.field_name"), field_id: requiredString(status.field_id, "status.field_id"), options: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, requiredString(value, `status.options.${key}`)])) },
    branch: { task: requiredString(branch.task, "branch.task"), loop: requiredString(branch.loop, "branch.loop") },
    prompts: { lifecycle_in_progress: requiredString(prompts.lifecycle_in_progress, "prompts.lifecycle_in_progress"), lifecycle_validation: requiredString(prompts.lifecycle_validation, "prompts.lifecycle_validation") },
    loops,
  };
}
export async function loadOctestraConfig(client: ConfigClient, ref?: string): Promise<OctestraConfig> {
  return parseOctestraConfig(await client.getContent(".github/octestra/config.yml", ref || undefined));
}
