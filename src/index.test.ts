import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index";

const mocks = vi.hoisted(() => ({
  client: {},
  finalizeTask: vi.fn(),
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  loadOctestraConfig: vi.fn(),
  finalizeTriage: vi.fn(),
  prepareTriage: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getBooleanInput: mocks.getBooleanInput,
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
  finalizeTriage: mocks.finalizeTriage,
  listEpics: vi.fn(),
  prepareTriage: mocks.prepareTriage,
}));

vi.mock("./lifecycle/operations", () => ({
  finalizeTask: mocks.finalizeTask,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("run", () => {
  it("dispatches loop/prepare-triage with the EPIC context", async () => {
    const inputs: Record<string, string> = {
      github_token: "token",
      issue_number: "42",
      "operation": "loop/prepare-triage",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.loadOctestraConfig.mockResolvedValue({
      prompts: {
        loop_todo: "custom/loop-prompt.hbs",
      },
    });

    await run();

    expect(mocks.prepareTriage).toHaveBeenCalledWith(
      {
        client: mocks.client,
        epicNumber: 42,
      },
      "custom/loop-prompt.hbs",
    );
    expect(mocks.loadOctestraConfig).toHaveBeenCalledWith(
      mocks.client,
      "",
    );
  });

  it("dispatches loop/finalize-triage with status configuration", async () => {
    const inputs: Record<string, string> = {
      github_token: "token",
      issue_number: "42",
      "operation": "loop/finalize-triage",
      result_path: "/tmp/triage-result.json",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.loadOctestraConfig.mockResolvedValue({
      status: {
        field_id: 9001,
      },
    });

    await run();

    expect(mocks.finalizeTriage).toHaveBeenCalledWith(
      {
        client: mocks.client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      "/tmp/triage-result.json",
    );
  });

  it("parses skip_validation before finalizing a task", async () => {
    const inputs: Record<string, string> = {
      branch_name: "octestra/example/issue-42",
      github_token: "token",
      issue_number: "42",
      operation: "lifecycle/finalize-task",
      skip_validation: "false",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.getBooleanInput.mockReturnValue(false);
    mocks.loadOctestraConfig.mockResolvedValue({
      branch: {
        task: "octestra/{epic_id}/issue-{issue_number}",
      },
      status: {
        field_id: 9001,
      },
    });

    await run();

    expect(mocks.getBooleanInput).toHaveBeenCalledWith("skip_validation");
    expect(mocks.finalizeTask).toHaveBeenCalledWith(
      {
        client: mocks.client,
        issueNumber: 42,
        statusFieldId: 9001,
      },
      "octestra/example/issue-42",
      false,
      "octestra/{epic_id}/issue-{issue_number}",
    );
  });
});
