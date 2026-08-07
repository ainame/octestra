import { describe, expect, it } from "vitest";
import { parseOctestraConfig } from "./config";
const base = `version: 1
github_app: { client_id: app }
runners: { orchestration: ubuntu-latest, agent: ubuntu-latest }
status:
  field_name: AI Task Status
  field_id: "1"
branch: { task: 'octestra/{epic_id}/issue-{issue_number}' }
prompts: { lifecycle_in_progress: task.hbs, lifecycle_validation: validation.hbs }
`;
describe("parseOctestraConfig", () => {
  it("rejects missing required keys", () => expect(() => parseOctestraConfig("version: 1")).toThrow("github_app"));
  it("rejects an unsupported version", () => expect(() => parseOctestraConfig(base.replace("version: 1", "version: 2"))).toThrow("version must be 1"));
  it("rejects a non-numeric status field ID", () => {
    expect(() => parseOctestraConfig(base.replace('field_id: "1"', "field_id: status"))).toThrow(
      "status.field_id must be a positive integer",
    );
  });
  it("parses a valid config", () => expect(parseOctestraConfig(base)).toEqual({
    version: 1,
    github_app: { client_id: "app" },
    runners: { orchestration: "ubuntu-latest", agent: "ubuntu-latest" },
    status: { field_name: "AI Task Status", field_id: 1 },
    branch: { task: "octestra/{epic_id}/issue-{issue_number}" },
    prompts: { lifecycle_in_progress: "task.hbs", lifecycle_validation: "validation.hbs" },
  }));
});
