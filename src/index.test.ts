import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index";

const mocks = vi.hoisted(() => ({
  client: {},
  getInput: vi.fn(),
  loadOctestraConfig: vi.fn(),
  prepareTriage: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mocks.getInput,
  setFailed: vi.fn(),
}));

vi.mock("./shared/config", () => ({
  loadOctestraConfig: mocks.loadOctestraConfig,
}));

vi.mock("./shared/github-client", () => ({
  GitHubClient: vi.fn(function GitHubClient() {
    return mocks.client;
  }),
}));

vi.mock("./loop/operations", () => ({
  listEpics: vi.fn(),
  prepareTriage: mocks.prepareTriage,
}));

vi.mock("./lifecycle/operations", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("run", () => {
  it("dispatches loop/prepare-triage with the EPIC context", async () => {
    const inputs: Record<string, string> = {
      "github-token": "token",
      "issue-number": "42",
      "operation": "loop/prepare-triage",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");

    await run();

    expect(mocks.prepareTriage).toHaveBeenCalledWith(
      {
        client: mocks.client,
        epicNumber: 42,
      },
    );
    expect(mocks.loadOctestraConfig).not.toHaveBeenCalled();
  });
});
