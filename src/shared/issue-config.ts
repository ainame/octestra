import { parse } from "yaml";

export interface EpicConfig {
  id: string;
  skillName?: string;
  draftPr: boolean;
  skipValidation: boolean;
  epicPrompt: string;
  validationPrompt: string;
}

export interface TaskConfig {
  target?: string;
  taskPrompt: string;
}

function extractBlock(body: string, name: string, required: boolean): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`\\\`\\\`\\\`${escapedName}\\s*\\n([\\s\\S]*?)\\n\\\`\\\`\\\``));

  if (match) {
    return match[1];
  }
  if (required) {
    throw new Error(`Issue body does not contain a ${name} block`);
  }
  return "";
}

export function parseEpicConfig(body: string): EpicConfig {
  const configText = extractBlock(body, "epic-config", true);
  const value: unknown = parse(configText);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("epic-config must be a mapping");
  }

  const config = value as Record<string, unknown>;
  const id = typeof config.id === "string" ? config.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error("epic-config id must be a non-empty lowercase slug");
  }

  const skillValue = config.skill;
  if (skillValue !== undefined && typeof skillValue !== "string") {
    throw new Error("epic-config skill must be a string when provided");
  }
  const skillName = skillValue?.trim() || undefined;

  // A task PR is opened ready for review, so an EPIC has to opt in to drafts. Marking a
  // finished PR ready by hand is friction on every task, and a repository that validates
  // has already reviewed the work by the time a human is asked to look.
  const draftPr = config.draft_pr ?? false;
  if (typeof draftPr !== "boolean") {
    throw new Error("epic-config draft_pr must be true or false");
  }

  const skipValidation = config.skip_validation ?? false;
  if (typeof skipValidation !== "boolean") {
    throw new Error("epic-config skip_validation must be true or false");
  }

  return {
    id,
    skillName,
    draftPr,
    skipValidation,
    epicPrompt: extractBlock(body, "epic-prompt", false),
    validationPrompt: extractBlock(body, "validation-prompt", false),
  };
}

export function parseTaskConfig(body: string): TaskConfig {
  const configText = extractBlock(body, "task-config", true);
  const value: unknown = parse(configText);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task-config must be a mapping");
  }

  const targetValue = (value as Record<string, unknown>).target;
  if (
    targetValue !== undefined &&
    targetValue !== null &&
    typeof targetValue !== "string"
  ) {
    throw new Error("task-config target must be a string or null");
  }

  const normalized = typeof targetValue === "string"
    ? targetValue.trim()
    : "";
  const target = normalized &&
      normalized.toLowerCase() !== "n/a" &&
      normalized.toLowerCase() !== "null"
    ? normalized
    : undefined;

  return {
    target,
    taskPrompt: extractBlock(body, "task-prompt", false),
  };
}
