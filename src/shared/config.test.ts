import { describe, expect, it } from "vitest";
import { parseOctestraConfig } from "./config";
const base = `version: 1
github_app: { client_id: app }
runners: { orchestration: ubuntu-latest, agent: ubuntu-latest }
status:
  field_name: AI Task Status
  field_id: "1"
branch: { task: 'octestra/{epic_id}/issue-{issue_number}' }
prompts: { lifecycle_in_progress: task.hbs, lifecycle_validation: validation.hbs, loop_todo: loop.hbs }
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
    prompts: {
      lifecycle_in_progress: "task.hbs",
      lifecycle_validation: "validation.hbs",
      loop_todo: "loop.hbs",
    },
    agent_timeout_minutes: { task: 50, validation: 50, triage: 50 },
    pull_request_validation_log: true,
  }));
  it("switches the pull request validation log off only with an explicit false", () => {
    expect(parseOctestraConfig(`${base}pull_request_validation_log: false\n`).pull_request_validation_log).toBe(false);
    expect(parseOctestraConfig(`${base}pull_request_validation_log:\n`).pull_request_validation_log).toBe(true);
    expect(() => parseOctestraConfig(`${base}pull_request_validation_log: "no"\n`)).toThrow(
      "pull_request_validation_log must be true or false",
    );
  });
  it("reads agent timeouts and defaults the phases left out", () => {
    const configured = `${base}agent_timeout_minutes:\n  validation: 80\n  triage: 20\n`;

    expect(parseOctestraConfig(configured).agent_timeout_minutes).toEqual({
      task: 50,
      validation: 80,
      triage: 20,
    });
  });
  it("accepts a quoted number and a leading zero the way YAML reads them", () => {
    expect(parseOctestraConfig(`${base}agent_timeout_minutes:\n  validation: "80"\n  task: 08\n`).agent_timeout_minutes)
      .toEqual({ task: 8, validation: 80, triage: 50 });
  });
  it.each([
    ["a quoted non-number", '"8h"'],
    ["a boolean", "true"],
    ["null", "null"],
    ["a fraction", "7.5"],
    ["zero", "0"],
    ["more than the job limit allows", "351"],
  ])("rejects %s as an agent timeout", (_label, value) => {
    expect(() => parseOctestraConfig(`${base}agent_timeout_minutes:\n  validation: ${value}\n`)).toThrow(
      "agent_timeout_minutes.validation must be a whole number of minutes from 1 to 350",
    );
  });
  it("treats an empty agent timeout section like a missing one", () => {
    expect(parseOctestraConfig(`${base}agent_timeout_minutes:\n`).agent_timeout_minutes).toEqual({
      task: 50,
      validation: 50,
      triage: 50,
    });
  });
  it("rejects an agent timeout section that is not a mapping", () => {
    expect(() => parseOctestraConfig(`${base}agent_timeout_minutes: 80\n`)).toThrow(
      "agent_timeout_minutes must be a mapping",
    );
  });
  it("uses the installed loop prompt path for legacy configs", () => {
    const legacy = base.replace(", loop_todo: loop.hbs", "");

    expect(parseOctestraConfig(legacy).prompts.loop_todo).toBe(
      ".github/octestra/prompts/loop-todo.md.hbs",
    );
  });
});
