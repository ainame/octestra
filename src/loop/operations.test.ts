import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@actions/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@actions/core")>()), setOutput: vi.fn() }));
import * as core from "@actions/core";
import { finalizeRun, selectTasks, type LoopClient } from "./operations";
const output = core.setOutput as ReturnType<typeof vi.fn>;
afterEach(() => output.mockClear());
const config = { prompt: "x", select: { epic: null, status: "Todo", labels: ["x"], limit: 300, scan_budget: 2, order: "oldest" as const }, apply: { allowed_status: ["Ready"], assign_owner: false, dry_run: false }, report_issue: null };
function client(items: any[] = []): LoopClient { return { listIssues: vi.fn().mockResolvedValue({ issues: items, partial: true }), listSubIssues: vi.fn(), getStatus: vi.fn().mockResolvedValue("Todo"), comment: vi.fn(), updateStatus: vi.fn(), getLatestAssignedUser: vi.fn() } as unknown as LoopClient; }
describe("selectTasks", () => {
  it("emits parseable empty selection", async () => { await selectTasks(client([]), config, "Custom"); expect(output).toHaveBeenCalledWith("issues", "[]"); expect(output).toHaveBeenCalledWith("loop_ready", "false"); });
  it("reports scan budget exhaustion and excludes pull requests", async () => { const c = client([{ number: 1, title: "PR", updated_at: "x", pull_request: {} }, { number: 2, title: "Issue", updated_at: "x" }]); await selectTasks(c, config, "Custom"); expect(output).toHaveBeenCalledWith("partial", "true"); expect(output).toHaveBeenCalledWith("issues", expect.stringContaining('"number":2')); });
  it("caps matrix output at 256", async () => { const c = client(Array.from({ length: 300 }, (_, i) => ({ number: i + 1, title: "x", updated_at: "x" }))); await selectTasks(c, { ...config, select: { ...config.select, limit: 300, scan_budget: 300 } }, "Custom"); const raw = output.mock.calls.find(([name]) => name === "issues")?.[1] as string; expect(JSON.parse(raw)).toHaveLength(256); });
});
describe("finalizeRun", () => {
  it("rejects malformed or missing proof", async () => { await expect(finalizeRun(client(), 1, config, "Custom", "missing.json", false)).rejects.toThrow(); });
  it("does not write in dry run or for disallowed status", async () => { const file = "loop-proof-test.json"; await import("node:fs/promises").then(({ writeFile }) => writeFile(file, '{"outcome":"passed","summary":"ok","next_status":"Blocked"}')); const c = client(); await finalizeRun(c, 1, config, "Custom", file, true); await finalizeRun(c, 1, config, "Custom", file, false); expect(c.updateStatus).not.toHaveBeenCalled(); await import("node:fs/promises").then(({ unlink }) => unlink(file)); });
});
