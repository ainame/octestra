import { describe, expect, it } from "vitest";
import { parseOctestraConfig } from "./config";
const base = `version: 1
github_app: { client_id: app }
runners: { orchestration: ubuntu-latest, agent: ubuntu-latest }
status:
  field_name: AI Task Status
  field_id: "1"
  options: { todo: "1", ready: "2", in_progress: "3", validation: "4", human_review: "5", blocked: "6", done: "7" }
branch: { task: 'octestra/{epic_id}/issue-{issue_number}', loop: 'octestra/loop/{loop_id}/{run_number}' }
prompts: { lifecycle_in_progress: task.hbs, lifecycle_validation: validation.hbs }
loops: {}
`;
describe("parseOctestraConfig", () => {
  it("rejects missing required keys", () => expect(() => parseOctestraConfig("version: 1")).toThrow("github_app"));
  it("rejects an unsupported version", () => expect(() => parseOctestraConfig(base.replace("version: 1", "version: 2"))).toThrow("version must be 1"));
  it("rejects an unbounded loop", () => expect(() => parseOctestraConfig(base.replace("loops: {}", "loops:\n  x:\n    prompt: x\n    select: { status: Todo, labels: [], limit: 1, scan_budget: 1 }\n    apply: { allowed_status: [Ready], assign_owner: true, dry_run: false }"))).toThrow("select.epic or select.labels"));
  it("rejects unsupported updated_before durations", () => expect(() => parseOctestraConfig(base.replace("loops: {}", "loops:\n  x:\n    prompt: x\n    select: { status: Todo, labels: [x], updated_before: yesterday, limit: 1, scan_budget: 1 }\n    apply: { allowed_status: [Ready], assign_owner: true, dry_run: false }"))).toThrow("must be a duration"));
  it("rejects non-boolean loop flags", () => expect(() => parseOctestraConfig(base.replace("loops: {}", "loops:\n  x:\n    prompt: x\n    select: { status: Todo, labels: [x], limit: 1, scan_budget: 1 }\n    apply: { allowed_status: [Ready], assign_owner: nope, dry_run: false }"))).toThrow("must be booleans"));
  it("accepts an aggregate loop that applies no status and reports to an issue", () => {
    const aggregate = base.replace(
      "loops: {}",
      [
        "loops:",
        "  retrospective:",
        "    prompt: .github/octestra/prompts/loop-retrospective.md.hbs",
        "    select: { status: Done, labels: [octestra-task], updated_before: 7d, limit: 20, scan_budget: 300, order: newest }",
        "    apply: { allowed_status: [], assign_owner: false, dry_run: false }",
        "    report_issue: 1",
      ].join("\n"),
    );

    const parsed = parseOctestraConfig(aggregate);

    expect(parsed.loops.retrospective.select.updated_before).toBe(604800);
    expect(parsed.loops.retrospective.select.order).toBe("newest");
    expect(parsed.loops.retrospective.apply.allowed_status).toEqual([]);
    expect(parsed.loops.retrospective.report_issue).toBe(1);
  });
});
