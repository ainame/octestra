import { describe, expect, it, vi } from "vitest";

const listForRepo = vi.fn();
const request = vi.fn();
vi.mock("@actions/github", () => ({
  getOctokit: () => ({
    rest: { issues: { listForRepo } },
    request,
  }),
}));
import { GitHubClient } from "./github-client";

function issues(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: start + index,
    title: `Issue ${start + index}`,
    updated_at: "2024-01-01T00:00:00Z",
  }));
}
describe("bounded issue pagination", () => {
  it("keeps per_page stable for a non-multiple scan budget", async () => {
    listForRepo.mockResolvedValueOnce({ data: issues(1, 100) }).mockResolvedValueOnce({ data: issues(101, 100) });
    const result = await new GitHubClient("token", "owner/repo").listIssues([], 150);
    expect(listForRepo).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, per_page: 100 }));
    expect(listForRepo).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, per_page: 100 }));
    expect(result.issues).toHaveLength(150);
    expect(result.issues.at(-1)?.number).toBe(150);
  });
});
