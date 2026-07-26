import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import {
  assignOwner,
  assignPullRequestOwner,
  finalizeMergedTask,
  finalizeTask,
  finalizeValidation,
  prepareTask,
  prepareValidation,
  reportFailure,
  reportProof,
  resolveTaskPullRequest,
  requestReview,
  resolveTaskBranchName,
  validateTransition,
  type OperationsClient,
  type OperationContext,
} from "./operations";

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return {
    ...actual,
    setOutput: vi.fn(),
  };
});

const temporaryDirectories: string[] = [];

async function proofResultPath(outcome: "passed" | "failed"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "proof-result-"));
  temporaryDirectories.push(directory);
  const resultPath = path.join(directory, "result.json");
  await writeFile(resultPath, JSON.stringify({
    outcome,
    summary: `Validation ${outcome}`,
    checks: [{
      name: "Targeted tests",
      kind: "test",
      result: outcome,
    }],
  }));
  return resultPath;
}

function createClient(overrides: Partial<OperationsClient> = {}): OperationsClient {
  return {
    getIssue: vi.fn().mockResolvedValue({
      title: "EPIC",
      body: [
        "```epic-config",
        "id: example",
        "skill: example",
        "validation_required: true",
        "```",
      ].join("\n"),
    }),
    isClosedByMergedPullRequest: vi.fn().mockResolvedValue(false),
    getParentNumber: vi.fn().mockResolvedValue(1),
    getUserDisplayName: vi.fn(),
    branchExists: vi.fn().mockResolvedValue(true),
    findOpenPullRequest: vi.fn().mockResolvedValue(42),
    assignIssue: vi.fn(),
    assignPullRequest: vi.fn(),
    getLatestAssignedUser: vi.fn().mockResolvedValue("reviewer"),
    findLinkedOpenPullRequest: vi.fn().mockResolvedValue(42),
    requestReviewer: vi.fn(),
    comment: vi.fn(),
    getStatus: vi.fn(),
    updateStatus: vi.fn(),
    clearStatus: vi.fn(),
    ...overrides,
  };
}

function createContext(client: OperationsClient): OperationContext {
  return {
    client,
    issueNumber: 123,
    statusFieldName: "AI Task Status",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_ACTOR = "github-actions[bot]";
  process.env.GITHUB_REPOSITORY = "example-org/example-repo";
  process.env.GITHUB_RUN_ID = "123456";
  process.env.GITHUB_SERVER_URL = "https://github.com";
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_WORKSPACE;
  delete process.env.RUNNER_TEMP;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("prepareTask", () => {
  it("assigns the owner and prepares the task prompt", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "prepare-task-"));
    temporaryDirectories.push(workspace);
    await writeFile(
      path.join(workspace, "prompt.md.hbs"),
      "{{target}}\n{{epicPrompt}}",
    );
    const client = createClient({
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 123
          ? {
            title: "A human-readable task title",
            body: [
              "```task-config",
              "target: Sources/Feature/Home.swift",
              "```",
              "",
              "```task-prompt",
              "Preserve the public API.",
              "```",
            ].join("\n"),
          }
          : {
            title: "EPIC",
            body: [
              "```epic-config",
              "id: example",
              "skill: example",
              "```",
              "",
              "```epic-prompt",
              "Use the existing architecture.",
              "```",
            ].join("\n"),
          }),
      getParentNumber: vi.fn().mockResolvedValue(1),
      getUserDisplayName: vi.fn().mockResolvedValue("Task Owner"),
      branchExists: vi.fn().mockResolvedValue(false),
      findLinkedOpenPullRequest: vi.fn().mockResolvedValue(undefined),
    });
    const setOutput = vi.mocked(core.setOutput);
    process.env.GITHUB_WORKSPACE = workspace;

    await prepareTask(
      createContext(client),
      "prompt.md.hbs",
      "task-owner",
      "User",
    );

    expect(client.assignIssue).toHaveBeenCalledWith(123, "task-owner");
    expect(setOutput).toHaveBeenCalledWith(
      "prompt",
      [
        "Sources/Feature/Home.swift",
        "Use the existing architecture.",
        "",
        "Preserve the public API.",
      ].join("\n"),
    );
    expect(setOutput).toHaveBeenCalledWith(
      "target_file",
      "Sources/Feature/Home.swift",
    );
    expect(setOutput).toHaveBeenCalledWith("task_ready", "true");
  });

  it("blocks and instructs the task owner when existing work is found", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "prepare-task-"));
    temporaryDirectories.push(workspace);
    await writeFile(path.join(workspace, "prompt.md.hbs"), "{{target}}");
    const client = createClient({
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 123
          ? {
            title: "Task",
            body: "```task-config\ntarget: Sources/Feature/Home.swift\n```",
          }
          : {
            title: "EPIC",
            body: "```epic-config\nid: example\n```",
          }),
      branchExists: vi.fn().mockResolvedValue(true),
      findLinkedOpenPullRequest: vi.fn().mockResolvedValue(42),
      getUserDisplayName: vi.fn().mockResolvedValue("Task Owner"),
    });
    const setOutput = vi.mocked(core.setOutput);
    process.env.GITHUB_WORKSPACE = workspace;

    await prepareTask(createContext(client), "prompt.md.hbs", "task-owner", "User");

    expect(client.updateStatus).toHaveBeenCalledWith(123, "AI Task Status", "Blocked");
    expect(client.comment).toHaveBeenCalledWith(
      123,
      expect.stringContaining("@task-owner"),
    );
    expect(setOutput).toHaveBeenCalledWith("task_ready", "false");
  });
});

describe("resolveTaskBranchName", () => {
  it("uses the EPIC ID and issue number in the default branch namespace", () => {
    expect(resolveTaskBranchName("objc-to-swift", 123)).toBe(
      "octestra/objc-to-swift/issue-123",
    );
  });

  it("supports a repository-defined branch template", () => {
    expect(resolveTaskBranchName("objc-to-swift", 123, "work/{epic_id}/task-{issue_number}")).toBe(
      "work/objc-to-swift/task-123",
    );
  });

  it("requires both identity placeholders", () => {
    expect(() => resolveTaskBranchName("objc-to-swift", 123, "work/{epic_id}")).toThrow(
      "{issue_number}",
    );
  });
});

describe("prepareValidation", () => {
  it("combines EPIC, task, and validation prompts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "prepare-validation-"));
    temporaryDirectories.push(workspace);
    await writeFile(path.join(workspace, "prompt.md.hbs"), "{{epicPrompt}}");
    const client = createClient({
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 123
          ? {
            title: "Create a new adapter",
            body: [
              "```task-config",
              "target: null",
              "```",
              "",
              "```task-prompt",
              "Preserve the public API.",
              "```",
            ].join("\n"),
          }
          : {
            title: "EPIC",
            body: [
              "```epic-config",
              "id: example",
              "skill: example",
              "validation_required: true",
              "```",
              "",
              "```epic-prompt",
              "Use the existing architecture.",
              "```",
              "",
              "```validation-prompt",
              "Run integration tests.",
              "```",
            ].join("\n"),
          }),
      getParentNumber: vi.fn().mockResolvedValue(1),
    });
    const setOutput = vi.mocked(core.setOutput);
    process.env.GITHUB_WORKSPACE = workspace;
    process.env.RUNNER_TEMP = workspace;

    await prepareValidation(createContext(client), "prompt.md.hbs");

    expect(setOutput).toHaveBeenCalledWith(
      "prompt",
      [
        "Use the existing architecture.",
        "",
        "Preserve the public API.",
        "",
        "Run integration tests.",
      ].join("\n"),
    );
    expect(setOutput).toHaveBeenCalledWith("target_file", "");
  });
});

describe("validateTransition", () => {
  it.each([
    ["", "Todo"],
    ["Todo", "Ready"],
    ["Ready", "In Progress"],
    ["In Progress", "Validation"],
    ["Validation", "Human Review"],
    ["Human Review", "Done"],
    ["In Progress", "Blocked"],
    ["Blocked", "Ready"],
  ])("allows %s -> %s", async (previousStatus, currentStatus) => {
    const client = createClient({
      getStatus: vi.fn().mockResolvedValue(currentStatus || undefined),
    });

    await expect(
      validateTransition(
        createContext(client),
        previousStatus,
        currentStatus,
        "User",
      ),
    ).resolves.toBe(true);

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.clearStatus).not.toHaveBeenCalled();
  });

  it("restores the previous status after an invalid user transition", async () => {
    const client = createClient({
      getStatus: vi.fn().mockResolvedValue("Validation"),
    });

    await expect(
      validateTransition(createContext(client), "Todo", "Validation", "User"),
    ).resolves.toBe(false);

    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Todo",
    );
  });

  it("removes an invalid initial field value", async () => {
    const client = createClient({
      getStatus: vi.fn().mockResolvedValue("Done"),
    });

    await validateTransition(createContext(client), "", "Done", "User");

    expect(client.clearStatus).toHaveBeenCalledWith(123, "AI Task Status");
  });

  it("does not repeat a correction triggered by the GitHub App", async () => {
    const client = createClient({
      getStatus: vi.fn().mockResolvedValue("Todo"),
    });

    await validateTransition(createContext(client), "Validation", "Todo", "Bot");

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.clearStatus).not.toHaveBeenCalled();
  });

  it("restores a status removed by a user", async () => {
    const client = createClient({
      getStatus: vi.fn().mockResolvedValue(undefined),
    });

    await validateTransition(createContext(client), "Validation", "", "User");

    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Validation",
    );
  });

  it("ignores a stale event when the live status has changed", async () => {
    const client = createClient({
      getStatus: vi.fn().mockResolvedValue("Blocked"),
    });

    await validateTransition(createContext(client), "Todo", "Ready", "User");

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.clearStatus).not.toHaveBeenCalled();
  });
});

describe("finalizeMergedTask", () => {
  it("moves a human-reviewed issue closed by a merged pull request to Done", async () => {
    const client = createClient({
      isClosedByMergedPullRequest: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockResolvedValue("Human Review"),
    });

    await finalizeMergedTask(createContext(client));

    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Done",
    );
  });

  it("leaves an issue closed without a merged pull request unchanged", async () => {
    const client = createClient({
      isClosedByMergedPullRequest: vi.fn().mockResolvedValue(false),
      getStatus: vi.fn().mockResolvedValue("Human Review"),
    });

    await finalizeMergedTask(createContext(client));

    expect(client.getStatus).toHaveBeenCalledWith(123, "AI Task Status");
    expect(client.updateStatus).not.toHaveBeenCalled();
  });

  it("ignores a closed issue without a task awaiting review", async () => {
    const client = createClient({
      isClosedByMergedPullRequest: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockResolvedValue("Validation"),
    });

    await finalizeMergedTask(createContext(client));

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.isClosedByMergedPullRequest).not.toHaveBeenCalled();
  });
});

describe("finalizeTask", () => {
  it("updates a completed task to its next state", async () => {
    const client = createClient();

    await finalizeTask(createContext(client));

    expect(client.comment).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Created task PR #42"),
    );
    expect(client.assignPullRequest).toHaveBeenCalledWith(42, "reviewer");
    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Validation",
    );
  });

  it("skips validation and requests review when configured", async () => {
    const client = createClient({
      getIssue: vi.fn().mockResolvedValue({
        title: "EPIC",
        body: [
          "```epic-config",
          "id: example",
          "skill: example",
          "validation_required: false",
          "```",
        ].join("\n"),
      }),
    });

    await finalizeTask(createContext(client));

    expect(client.assignPullRequest).toHaveBeenCalledWith(42, "reviewer");
    expect(client.requestReviewer).toHaveBeenCalledWith(42, "reviewer");
    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Human Review",
    );
  });

  it("blocks a task when its branch was not created", async () => {
    const client = createClient({
      branchExists: vi.fn().mockResolvedValue(false),
    });

    await finalizeTask(createContext(client));

    expect(client.findOpenPullRequest).not.toHaveBeenCalled();
    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Blocked",
    );
  });
});

describe("assignOwner", () => {
  it("assigns a user that moved the task to In Progress", async () => {
    const client = createClient();

    await assignOwner(createContext(client), "task-owner", "User");

    expect(client.assignIssue).toHaveBeenCalledWith(123, "task-owner");
  });

  it("keeps the existing owner for bot transitions", async () => {
    const client = createClient();

    await assignOwner(createContext(client), "task-app[bot]", "Bot");

    expect(client.assignIssue).not.toHaveBeenCalled();
  });
});

describe("assignPullRequestOwner", () => {
  it("assigns the issue task owner to the pull request", async () => {
    const client = createClient();

    await expect(
      assignPullRequestOwner(createContext(client), 42),
    ).resolves.toBe("reviewer");

    expect(client.assignPullRequest).toHaveBeenCalledWith(42, "reviewer");
    expect(core.setOutput).toHaveBeenCalledWith("task_owner", "reviewer");
  });
});

describe("requestReview", () => {
  it("requests review from the latest issue assignee", async () => {
    const client = createClient();

    await expect(requestReview(createContext(client), 42)).resolves.toBe("reviewer");

    expect(client.assignPullRequest).toHaveBeenCalledWith(42, "reviewer");
    expect(client.requestReviewer).toHaveBeenCalledWith(42, "reviewer");
    expect(core.setOutput).toHaveBeenCalledWith("reviewer", "reviewer");
  });

  it("does not request review without an assigned task owner", async () => {
    const client = createClient({
      getLatestAssignedUser: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      requestReview(createContext(client), 42),
    ).rejects.toThrow("No assigned task owner");
    expect(client.requestReviewer).not.toHaveBeenCalled();
  });
});

describe("prepareValidation", () => {
  it("publishes the resolved task branch for checkout", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "prepare-validation-"));
    const runnerTemp = await mkdtemp(path.join(tmpdir(), "prepare-validation-temp-"));
    temporaryDirectories.push(workspace, runnerTemp);
    await writeFile(path.join(workspace, "prompt.md.hbs"), "Validate PR #{{pullNumber}}");
    process.env.GITHUB_WORKSPACE = workspace;
    process.env.RUNNER_TEMP = runnerTemp;

    const client = createClient({
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 123
          ? {
            title: "Task",
            body: [
              "```task-config",
              "target: Sources/Feature.swift",
              "```",
            ].join("\n"),
          }
          : {
            title: "EPIC",
            body: [
              "```epic-config",
              "id: example",
              "```",
            ].join("\n"),
          }),
    });

    await prepareValidation(createContext(client), "prompt.md.hbs");

    expect(core.setOutput).toHaveBeenCalledWith(
      "branch_name",
      "octestra/example/issue-123",
    );
  });
});

describe("resolveTaskPullRequest", () => {
  it("publishes the open pull request for a task branch", async () => {
    const client = createClient();

    await expect(
      resolveTaskPullRequest(createContext(client), "task/example/issue-123"),
    ).resolves.toBe(42);

    expect(core.setOutput).toHaveBeenCalledWith("pull_number", 42);
  });
});

describe("reportProof", () => {
  it("posts the consumer proof without changing lifecycle status", async () => {
    const client = createClient();
    const proofPath = await proofResultPath("passed");
    const workspace = await mkdtemp(path.join(tmpdir(), "proof-workspace-"));
    temporaryDirectories.push(workspace);
    await writeFile(path.join(workspace, "README.md"), "proof subject\n");
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync("git", ["add", "README.md"], { cwd: workspace });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Octestra Test",
        "-c",
        "user.email=octestra@example.com",
        "commit",
        "--quiet",
        "-m",
        "Create proof subject",
      ],
      { cwd: workspace },
    );
    const subjectSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    process.env.GITHUB_WORKSPACE = workspace;

    await reportProof(createContext(client), proofPath, {
      pullNumber: 42,
    });

    expect(client.comment).toHaveBeenCalledWith(
      123,
      expect.stringContaining("## ✅ Passed validation proof"),
    );
    expect(client.comment).toHaveBeenCalledWith(
      123,
      expect.stringContaining(subjectSha.slice(0, 12)),
    );
    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("outcome", "passed");
  });
});

describe("finalizeValidation", () => {
  it("reports proof, requests review, and advances a passed validation", async () => {
    const client = createClient();
    const proofPath = await proofResultPath("passed");

    await finalizeValidation(
      createContext(client),
      42,
      proofPath,
    );

    expect(client.comment).toHaveBeenCalledWith(
      123,
      expect.stringContaining("## ✅ Passed validation proof"),
    );
    expect(client.assignPullRequest).toHaveBeenCalledWith(42, "reviewer");
    expect(client.requestReviewer).toHaveBeenCalledWith(42, "reviewer");
    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Human Review",
    );
  });

  it("reports proof and moves a failed validation to the failure status", async () => {
    const client = createClient();
    const proofPath = await proofResultPath("failed");

    await finalizeValidation(
      createContext(client),
      42,
      proofPath,
    );

    expect(client.comment).toHaveBeenCalled();
    expect(client.requestReviewer).not.toHaveBeenCalled();
    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Blocked",
    );
  });
});

describe("reportFailure", () => {
  it("updates status even when posting the failure comment fails", async () => {
    const client = createClient({
      comment: vi.fn().mockRejectedValue(new Error("comment failed")),
    });

    await reportFailure(
      createContext(client),
    );

    expect(client.updateStatus).toHaveBeenCalledWith(
      123,
      "AI Task Status",
      "Blocked",
    );
  });
});
