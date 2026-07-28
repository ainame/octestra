import { describe, expect, it } from "vitest";
import type { OctestraConfig } from "./config";
import { optionIdOf, parseOptionId, statusKeyOf, statusVocabulary } from "./status";

function configWith(options: Record<string, string>): OctestraConfig {
  return {
    version: 1,
    github_app: { client_id: "client" },
    runners: { orchestration: "ubuntu-latest", agent: "ubuntu-latest" },
    status: { field_name: "AI Task Status", field_id: "5001", options },
    branch: { task: "octestra/{epic_id}/issue-{issue_number}", loop: "octestra/loop/{loop_id}/{run_number}" },
    prompts: { lifecycle_in_progress: "a.hbs", lifecycle_validation: "b.hbs" },
    loops: {},
  };
}

const options = {
  todo: "7001",
  ready: "7002",
  in_progress: "7003",
  validation: "7004",
  human_review: "7005",
  blocked: "7006",
  done: "7007",
};

describe("statusVocabulary", () => {
  it("maps every status key to its option ID and back", () => {
    const vocabulary = statusVocabulary(configWith(options));

    expect(vocabulary.fieldId).toBe(5001);
    expect(vocabulary.fieldName).toBe("AI Task Status");
    expect(optionIdOf(vocabulary, "human_review")).toBe(7005);
    expect(statusKeyOf(vocabulary, 7005)).toBe("human_review");
  });

  it("reports no key for an option outside the Octestra graph", () => {
    const vocabulary = statusVocabulary(configWith(options));

    expect(statusKeyOf(vocabulary, 9999)).toBeUndefined();
    expect(statusKeyOf(vocabulary, undefined)).toBeUndefined();
  });

  it("rejects an option ID that is not a positive integer", () => {
    expect(() => statusVocabulary(configWith({ ...options, blocked: "not-an-id" })))
      .toThrow("status.options.blocked");
  });

  it("rejects two statuses sharing one option ID", () => {
    expect(() => statusVocabulary(configWith({ ...options, blocked: options.done })))
      .toThrow("distinct option ID");
  });
});

describe("parseOptionId", () => {
  it("treats an absent value as no status, which a new task legitimately has", () => {
    expect(parseOptionId("")).toBeUndefined();
    expect(parseOptionId("   ")).toBeUndefined();
  });

  it("parses a numeric option ID", () => {
    expect(parseOptionId("7003")).toBe(7003);
  });

  it("rejects a display name supplied where an option ID belongs", () => {
    expect(() => parseOptionId("In Progress")).toThrow("must be a positive integer");
  });
});
