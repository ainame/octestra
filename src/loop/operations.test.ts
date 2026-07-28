import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  setOutput: vi.fn(),
}));

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import type { LoopConfig } from "../shared/config";
import {
  finalizeRun,
  parseLoopSelection,
  prepareRun,
  resolveLoopBranchName,
  selectTasks,
  type LoopClient,
  type LoopContext,
} from "./operations";

const output = core.setOutput as ReturnType<typeof vi.fn>;

const config: LoopConfig = {
  prompt: "prompts/loop.md.hbs",
  select: { epic: null, status: "Todo", labels: ["task"], limit: 300, scan_budget: 300, order: "oldest" },
  apply: { allowed_status: ["Ready"], assign_owner: false, dry_run: false },
  report_issue: null,
};

const loop: LoopContext = { loop_id: "triage-todo", dry_run: false };

interface FakeClient extends LoopClient {
  listIssues: Mock;
  comment: Mock;
  assignIssue: Mock;
  updateStatus: Mock;
  getLatestAssignedUser: Mock;
}

function fakeClient(items: Array<Record<string, unknown>> = [], partial = true): FakeClient {
  return {
    listIssues: vi.fn().mockResolvedValue({ issues: items, partial }),
    listSubIssues: vi.fn().mockResolvedValue({ issues: [], partial: false }),
    getStatus: vi.fn().mockResolvedValue("Todo"),
    comment: vi.fn(),
    assignIssue: vi.fn(),
    updateStatus: vi.fn(),
    getLatestAssignedUser: vi.fn(),
  } as unknown as FakeClient;
}

function outputValue(name: string): string | undefined {
  const call = output.mock.calls.find(([key]) => key === name);
  return call === undefined ? undefined : (call[1] as string);
}

afterEach(() => output.mockClear());

describe("selectTasks", () => {
  it("emits a parseable empty selection", async () => {
    await selectTasks(fakeClient([]), config, "Custom");

    expect(outputValue("issues")).toBe("[]");
    expect(outputValue("count")).toBe("0");
    expect(outputValue("loop_ready")).toBe("false");
  });

  it("excludes pull requests and reports scan budget exhaustion", async () => {
    const client = fakeClient([
      { number: 1, title: "PR", updated_at: "2020-01-01T00:00:00Z", pull_request: {} },
      { number: 2, title: "Issue", updated_at: "2020-01-01T00:00:00Z" },
    ]);

    await selectTasks(client, config, "Custom");

    expect(outputValue("partial")).toBe("true");
    expect(outputValue("issues")).toContain('"number":2');
    expect(outputValue("issues")).not.toContain('"number":1');
  });

  it("caps the matrix at 256 tasks", async () => {
    const items = Array.from({ length: 300 }, (_, index) => ({
      number: index + 1,
      title: "task",
      updated_at: "2020-01-01T00:00:00Z",
    }));

    await selectTasks(fakeClient(items), config, "Custom");

    expect(JSON.parse(outputValue("issues") as string)).toHaveLength(256);
  });

  it("orders oldest first and skips recently updated candidates", async () => {
    const client = fakeClient([
      { number: 1, title: "new", updated_at: "2024-01-02T00:00:00Z" },
      { number: 2, title: "old", updated_at: "2024-01-01T00:00:00Z" },
    ]);
    const stale = { ...config, select: { ...config.select, limit: 1, updated_before: 86400 } };

    await selectTasks(client, stale, "Custom", new Date("2024-01-03T00:00:00Z"));

    expect(outputValue("issues")).toContain('"number":2');
    expect(outputValue("issues")).not.toContain('"number":1');
  });
});

describe("parseLoopSelection", () => {
  it("rejects anything that is not an array of issues", () => {
    expect(() => parseLoopSelection('{"number":1}')).toThrow("must be a JSON array");
    expect(() => parseLoopSelection("[1]")).toThrow("must be an object");
    expect(() => parseLoopSelection('[{"number":0}]')).toThrow("positive integer");
  });

  it("keeps the fields an aggregate prompt renders", () => {
    const parsed = parseLoopSelection('[{"number":7,"title":"t","status":"Done","updated_at":"2024-01-01"}]');

    expect(parsed).toEqual([{ number: 7, title: "t", status: "Done", updated_at: "2024-01-01" }]);
  });
});

describe("resolveLoopBranchName", () => {
  it("requires both placeholders and a run number", () => {
    expect(() => resolveLoopBranchName("octestra/loop/{loop_id}", "x", "4")).toThrow("{run_number}");
    expect(() => resolveLoopBranchName("octestra/loop/{loop_id}/{run_number}", "x", "")).toThrow("run number");
  });

  it("rejects a template that resolves to an unusable ref", () => {
    expect(() => resolveLoopBranchName("{loop_id}/../{run_number}", "x", "4")).toThrow("invalid branch name");
  });

  it("resolves the configured template", () => {
    expect(resolveLoopBranchName("octestra/loop/{loop_id}/{run_number}", "retrospective", "12"))
      .toBe("octestra/loop/retrospective/12");
  });
});

describe("prepareRun", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "octestra-loop-"));
    await mkdir(path.join(workspace, "prompts"), { recursive: true });
    process.env.GITHUB_WORKSPACE = workspace;
  });

  afterEach(async () => {
    delete process.env.GITHUB_WORKSPACE;
    await rm(workspace, { recursive: true, force: true });
  });

  it("renders a per-issue run without a shared branch", async () => {
    await writeFile(path.join(workspace, "prompts/loop.md.hbs"), "Triage #{{issueNumber}} into {{resultPath}}");

    await prepareRun(loop, config, { issueNumber: 42, runNumber: "9" });

    expect(outputValue("result_path")).toBe("octestra-loop-triage-todo-42.json");
    expect(outputValue("artifact_path")).toBe("octestra-loop-triage-todo-42-artifacts");
    expect(outputValue("branch_name")).toBeUndefined();
    expect(outputValue("prompt")).toBe("Triage #42 into octestra-loop-triage-todo-42.json");
  });

  it("renders an aggregate run with the selection and a loop branch", async () => {
    await writeFile(
      path.join(workspace, "prompts/loop.md.hbs"),
      "{{issueCount}} on {{branchName}}:{{#each issues}} #{{number}}{{/each}} -> {{patchPath}}",
    );
    const issues = [
      { number: 7, title: "a", status: "Done", updated_at: "2024-01-01" },
      { number: 8, title: "b", status: "Done", updated_at: "2024-01-02" },
    ];

    await prepareRun(loop, config, { issues, runNumber: "12", branchTemplate: "octestra/loop/{loop_id}/{run_number}" });

    expect(outputValue("result_path")).toBe("octestra-loop-triage-todo.json");
    expect(outputValue("patch_path")).toBe("octestra-loop-triage-todo.patch");
    expect(outputValue("branch_name")).toBe("octestra/loop/triage-todo/12");
    expect(outputValue("prompt")).toBe("2 on octestra/loop/triage-todo/12: #7 #8 -> octestra-loop-triage-todo.patch");
  });

  it("fails an aggregate run when the workflow supplied no run number", async () => {
    await writeFile(path.join(workspace, "prompts/loop.md.hbs"), "x");

    await expect(prepareRun(loop, config, { issues: [], runNumber: "" })).rejects.toThrow("run number");
  });
});

describe("finalizeRun", () => {
  let proofPath: string;

  beforeEach(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "octestra-proof-"));
    proofPath = path.join(directory, "result.json");
  });

  async function writeProof(document: Record<string, unknown>): Promise<void> {
    await writeFile(proofPath, JSON.stringify(document));
  }

  it("rejects a missing proof document", async () => {
    await expect(finalizeRun(fakeClient(), config, "Custom", proofPath, false, 1)).rejects.toThrow();
  });

  it("applies an allowed status and posts the proof comment", async () => {
    await writeProof({ outcome: "passed", summary: "ok", next_status: "Ready" });
    const client = fakeClient();

    await finalizeRun(client, config, "Custom Field", proofPath, false, 7);

    expect(client.comment).toHaveBeenCalledTimes(1);
    expect(client.updateStatus).toHaveBeenCalledWith(7, "Custom Field", "Ready");
    expect(outputValue("applied")).toBe("true");
    expect(outputValue("outcome")).toBe("passed");
  });

  it("comments but never writes for a dry run or a disallowed status", async () => {
    await writeProof({ outcome: "passed", summary: "ok", next_status: "Blocked" });
    const client = fakeClient();

    await finalizeRun(client, config, "Custom", proofPath, true, 7);
    await finalizeRun(client, config, "Custom", proofPath, false, 7);

    expect(client.comment).toHaveBeenCalledTimes(2);
    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(outputValue("applied")).toBe("false");
  });

  it("honours a loop pinned to dry run in config even when the run did not ask for one", async () => {
    await writeProof({ outcome: "passed", summary: "ok", next_status: "Ready" });
    const client = fakeClient();
    const pinned = { ...config, apply: { ...config.apply, dry_run: true } };

    await finalizeRun(client, pinned, "Custom", proofPath, false, 7);

    expect(client.comment).toHaveBeenCalledTimes(1);
    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(outputValue("applied")).toBe("false");
  });

  it("assigns the task owner before promoting and refuses when there is none", async () => {
    await writeProof({ outcome: "passed", summary: "ok", next_status: "Ready" });
    const client = fakeClient();
    const assigning = { ...config, apply: { ...config.apply, assign_owner: true } };
    client.getLatestAssignedUser.mockResolvedValue("owner");

    await finalizeRun(client, assigning, "Custom", proofPath, false, 7);
    expect(client.assignIssue).toHaveBeenCalledWith(7, "owner");

    client.getLatestAssignedUser.mockResolvedValue(undefined);
    await expect(finalizeRun(client, assigning, "Custom", proofPath, false, 7)).rejects.toThrow("no task owner");
  });

  it("reports an aggregate run on report_issue and never changes a status", async () => {
    await writeProof({ outcome: "passed", summary: "ok", next_status: "Ready" });
    const client = fakeClient();

    await finalizeRun(client, { ...config, report_issue: 99 }, "Custom", proofPath, false);

    expect(client.comment).toHaveBeenCalledTimes(1);
    expect(client.comment.mock.calls[0][0]).toBe(99);
    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(outputValue("applied")).toBe("false");
  });

  it("fails when an aggregate run has nowhere to report", async () => {
    await writeProof({ outcome: "passed", summary: "ok" });

    await expect(finalizeRun(fakeClient(), config, "Custom", proofPath, false)).rejects.toThrow("report_issue");
  });
});
