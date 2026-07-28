import type { OctestraConfig } from "./config";

// The seven keys are Octestra's internal vocabulary for the status graph. They are
// stable because they live in config.yml, unlike the organization's option display
// names, which a maintainer can rename at any time (P1).
export const statusKeys = [
  "todo",
  "ready",
  "in_progress",
  "validation",
  "human_review",
  "blocked",
  "done",
] as const;

export type StatusKey = typeof statusKeys[number];

// Identity is the option ID. Display names are presentation only: they are never
// compared against, and they are resolved live from the field definition at the
// one point that needs them, so renaming an option cannot break a transition.
export interface StatusVocabulary {
  fieldId: number;
  fieldName: string;
  keyToOptionId: Map<StatusKey, number>;
  optionIdToKey: Map<number, StatusKey>;
}

function numericId(value: string, name: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`config.yml ${name} must be a positive integer option ID, got ${value}`);
  }
  return id;
}

export function statusVocabulary(config: OctestraConfig): StatusVocabulary {
  const keyToOptionId = new Map<StatusKey, number>();
  const optionIdToKey = new Map<number, StatusKey>();
  for (const key of statusKeys) {
    const id = numericId(config.status.options[key]!, `status.options.${key}`);
    keyToOptionId.set(key, id);
    optionIdToKey.set(id, key);
  }
  if (optionIdToKey.size !== statusKeys.length) {
    throw new Error("config.yml status.options must map each status to a distinct option ID");
  }
  return {
    fieldId: numericId(config.status.field_id, "status.field_id"),
    fieldName: config.status.field_name,
    keyToOptionId,
    optionIdToKey,
  };
}

export function statusKeyOf(
  vocabulary: StatusVocabulary,
  optionId: number | undefined,
): StatusKey | undefined {
  if (optionId === undefined) {
    return undefined;
  }
  return vocabulary.optionIdToKey.get(optionId);
}

export function optionIdOf(vocabulary: StatusVocabulary, key: StatusKey): number {
  const optionId = vocabulary.keyToOptionId.get(key);
  if (optionId === undefined) {
    throw new Error(`config.yml status.options is missing ${key}`);
  }
  return optionId;
}

// Parses an option ID supplied by a workflow from the Issue Field event payload.
// An absent value is legitimate: a task entering the graph has no previous status.
export function parseOptionId(rawValue: string): number | undefined {
  if (!rawValue.trim()) {
    return undefined;
  }
  const id = Number(rawValue);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`status option ID must be a positive integer, got ${rawValue}`);
  }
  return id;
}
