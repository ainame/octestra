import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index";

const mocks = vi.hoisted(() => ({
  client: {},
  artifactClient: {},
  finalizeTask: vi.fn(),
  finalizeValidation: vi.fn(),
  getInput: vi.fn(),
  getMultilineInput: vi.fn().mockReturnValue([]),
  getBooleanInput: vi.fn(),
  loadOctestraConfig: vi.fn(),
  finalizeTriage: vi.fn(),
  prepareTriage: vi.fn(),
  listEpics: vi.fn(),
  validateTransition: vi.fn(),
  setOutput: vi.fn(),
  uploadArtifacts: vi.fn(),
  warning: vi.fn(),
  workflowRunUrl: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getBooleanInput: mocks.getBooleanInput,
  getInput: mocks.getInput,
  getMultilineInput: mocks.getMultilineInput,
  setFailed: vi.fn(),
  setOutput: mocks.setOutput,
  warning: mocks.warning,
}));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: vi.fn(function DefaultArtifactClient() {
    return mocks.artifactClient;
  }),
}));

vi.mock("./shared/artifacts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./shared/artifacts")>(),
  uploadArtifacts: mocks.uploadArtifacts,
}));

vi.mock("./shared/workflow-run", () => ({
  workflowRunUrl: mocks.workflowRunUrl,
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
  listEpics: mocks.listEpics,
  prepareTriage: mocks.prepareTriage,
}));

vi.mock("./lifecycle/operations", () => ({
  finalizeTask: mocks.finalizeTask,
  finalizeValidation: mocks.finalizeValidation,
  validateTransition: mocks.validateTransition,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("run", () => {
  it("dispatches upload-artifacts and publishes its links as outputs", async () => {
    const inputs: Record<string, string> = {
      artifact_path: "/runner/temp/octestra-validation-artifacts",
      github_token: "token",
      operation: "upload-artifacts",
      result_path: "/runner/temp/result.json",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.workflowRunUrl.mockReturnValue("https://github.com/example-org/consumer/actions/runs/7");
    mocks.uploadArtifacts.mockResolvedValue({
      links: [
        { name: "screens/home.png", url: "https://github.com/example-org/consumer/actions/runs/7/artifacts/1" },
        { name: "result.json", url: "https://github.com/example-org/consumer/actions/runs/7/artifacts/2" },
      ],
      skipped: [],
      failed: [],
    });

    await run();

    expect(mocks.uploadArtifacts).toHaveBeenCalledWith({
      artifactPath: "/runner/temp/octestra-validation-artifacts",
      resultPath: "/runner/temp/result.json",
      uploader: mocks.artifactClient,
      runUrl: "https://github.com/example-org/consumer/actions/runs/7",
    });
    expect(mocks.setOutput).toHaveBeenCalledWith(
      "artifact_links",
      "screens/home.png https://github.com/example-org/consumer/actions/runs/7/artifacts/1\n"
        + "result.json https://github.com/example-org/consumer/actions/runs/7/artifacts/2",
    );
    expect(mocks.setOutput).toHaveBeenCalledWith("artifact_count", "2");
    expect(mocks.loadOctestraConfig).not.toHaveBeenCalled();
  });

  it("publishes empty outputs when upload-artifacts cannot even start", async () => {
    const inputs: Record<string, string> = {
      artifact_path: "/runner/temp/octestra-validation-artifacts",
      github_token: "token",
      operation: "upload-artifacts",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.workflowRunUrl.mockImplementation(() => {
      throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID must be set");
    });

    await run();

    expect(mocks.uploadArtifacts).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("GITHUB_REPOSITORY and GITHUB_RUN_ID must be set"),
    );
    expect(mocks.setOutput).toHaveBeenCalledWith("artifact_links", "");
    expect(mocks.setOutput).toHaveBeenCalledWith("artifact_count", "0");
  });

  it("dispatches lifecycle/finalize-validation with the links and the log switch", async () => {
    const inputs: Record<string, string> = {
      artifact_links: "screens/home.png https://github.com/example-org/consumer/actions/runs/7/artifacts/1",
      github_token: "token",
      issue_number: "42",
      operation: "lifecycle/finalize-validation",
      pull_number: "57",
      result_path: "/runner/temp/result.json",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.getMultilineInput.mockImplementation((name: string) => (inputs[name] ?? "").split("\n").filter(Boolean));
    mocks.loadOctestraConfig.mockResolvedValue({
      status: { field_id: 9001 },
      append_validation_result_to_pr_body: false,
    });

    await run();

    expect(mocks.finalizeValidation).toHaveBeenCalledWith(
      { client: mocks.client, issueNumber: 42, statusFieldId: 9001 },
      57,
      "/runner/temp/result.json",
      {
        artifactLinks: [{
          name: "screens/home.png",
          url: "https://github.com/example-org/consumer/actions/runs/7/artifacts/1",
        }],
        appendValidationResultToPrBody: false,
      },
    );
  });

  it("dispatches lifecycle/validate-transition with the configured agent timeouts", async () => {
    const inputs: Record<string, string> = {
      current_status: "Validation",
      github_token: "token",
      issue_number: "42",
      operation: "lifecycle/validate-transition",
      previous_status: "Ready",
      trigger_actor: "task-owner",
      trigger_actor_type: "User",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.loadOctestraConfig.mockResolvedValue({
      status: { field_id: 9001 },
      agent_timeout_minutes: { task: 50, validation: 80, triage: 20 },
    });

    await run();

    expect(mocks.validateTransition).toHaveBeenCalledWith(
      { client: mocks.client, issueNumber: 42, statusFieldId: 9001 },
      "Ready",
      "Validation",
      "task-owner",
      "User",
      { task: 50, validation: 80, triage: 20 },
    );
  });

  it("dispatches loop/list-epics with the configured agent timeouts", async () => {
    const inputs: Record<string, string> = {
      github_token: "token",
      operation: "loop/list-epics",
    };
    mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
    mocks.loadOctestraConfig.mockResolvedValue({
      agent_timeout_minutes: { task: 50, validation: 80, triage: 20 },
    });

    await run();

    expect(mocks.listEpics).toHaveBeenCalledWith(
      mocks.client,
      { task: 50, validation: 80, triage: 20 },
    );
  });

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
      agent_timeout_minutes: { task: 50, validation: 50, triage: 20 },
    });

    await run();

    expect(mocks.prepareTriage).toHaveBeenCalledWith(
      {
        client: mocks.client,
        epicNumber: 42,
      },
      "custom/loop-prompt.hbs",
      20,
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
