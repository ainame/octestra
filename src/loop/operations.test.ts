import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  setOutput: vi.fn(),
}));
import * as core from "@actions/core";
import { unlink, writeFile } from "node:fs/promises";
import { finalizeRun, selectTasks, type LoopClient } from "./operations";

const output = core.setOutput as ReturnType<typeof vi.fn>;
const config = { prompt: "x", select: { epic: null, status: "Todo", labels: ["x"], limit: 300, scan_budget: 300, order: "oldest" as const }, apply: { allowed_status: ["Ready"], assign_owner: false, dry_run: false }, report_issue: null };
afterEach(() => output.mockClear());
function client(items: any[] = []): LoopClient {
  return { listIssues: vi.fn().mockResolvedValue({ issues: items, partial: true }), listSubIssues: vi.fn(), getStatus: vi.fn().mockResolvedValue("Todo"), comment: vi.fn(), assignIssue: vi.fn(), updateStatus: vi.fn(), getLatestAssignedUser: vi.fn() } as unknown as LoopClient;
}
function outputValue(name: string): unknown { return output.mock.calls.find(([key]) => key === name)?.[1]; }
describe("selectTasks", () => {
  it("emits a parseable empty selection", async () => { await selectTasks(client([]), config, "Custom"); expect(outputValue("issues")).toBe("[]"); expect(outputValue("loop_ready")).toBe("false"); });
  it("reports scan budget exhaustion and excludes pull requests", async () => { const c = client([{ number: 1, title: "PR", updated_at: "2020-01-01", pull_request: {} }, { number: 2, title: "Issue", updated_at: "2020-01-01" }]); await selectTasks(c, config, "Custom"); expect(outputValue("partial")).toBe("true"); expect(outputValue("issues")).toContain('"number":2'); });
  it("caps matrix output at 256", async () => { const c = client(Array.from({ length: 300 }, (_, index) => ({ number: index + 1, title: "x", updated_at: "2020-01-01" }))); await selectTasks(c, config, "Custom"); expect(JSON.parse(outputValue("issues") as string)).toHaveLength(256); });
  it("sorts oldest first and skips recently updated candidates", async () => { const c = client([{ number: 1, title: "new", updated_at: "2024-01-02T00:00:00Z" }, { number: 2, title: "old", updated_at: "2024-01-01T00:00:00Z" }]); await selectTasks(c, { ...config, select: { ...config.select, limit: 1, updated_before: 86400 } }, "Custom", new Date("2024-01-03T00:00:00Z")); expect(outputValue("issues")).toContain('"number":2'); });
});
describe("finalizeRun", () => {
  it("rejects missing proof", async () => { await expect(finalizeRun(client(), 1, config, "Custom", "missing.json", false)).rejects.toThrow(); });
  it("does not write in dry run or for disallowed status", async () => { const file = "loop-proof-test.json"; await writeFile(file, '{"outcome":"passed","summary":"ok","next_status":"Blocked"}'); const c = client(); await finalizeRun(c, 1, config, "Custom", file, true); await finalizeRun(c, 1, config, "Custom", file, false); expect(c.updateStatus).not.toHaveBeenCalled(); await unlink(file); });
  it("applies an allowed requested status and posts proof", async () => { const file = "loop-proof-test.json"; await writeFile(file, '{"outcome":"passed","summary":"ok","next_status":"Ready"}'); const c = client(); await finalizeRun(c, 7, config, "Custom Field", file, false); expect(c.comment).toHaveBeenCalled(); expect(c.updateStatus).toHaveBeenCalledWith(7, "Custom Field", "Ready"); expect(outputValue("applied")).toBe("true"); await unlink(file); });
  it("assigns an owner before applying and fails without one", async () => { const file = "loop-proof-test.json"; await writeFile(file, '{"outcome":"passed","summary":"ok","next_status":"Ready"}'); const c = client(); (c.getLatestAssignedUser as ReturnType<typeof vi.fn>).mockResolvedValue("owner"); await finalizeRun(c, 7, { ...config, apply: { ...config.apply, assign_owner: true } }, "Custom", file, false); expect(c.assignIssue).toHaveBeenCalledWith(7, "owner"); (c.getLatestAssignedUser as ReturnType<typeof vi.fn>).mockResolvedValue(undefined); await expect(finalizeRun(c, 7, { ...config, apply: { ...config.apply, assign_owner: true } }, "Custom", file, false)).rejects.toThrow("no task owner"); await unlink(file); });
});
