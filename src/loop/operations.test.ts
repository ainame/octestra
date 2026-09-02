import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import {
  finalizeTriage,
  listEpics,
  prepareTriage,
} from "./operations";

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return {
    ...actual,
    exportVariable: vi.fn(),
    setOutput: vi.fn(),
    warning: vi.fn(),
    summary: {
      addRaw: vi.fn(),
      write: vi.fn(),
    },
  };
});

const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_ACTOR = "github-actions[bot]";
  process.env.GITHUB_REPOSITORY = "example-org/example-repo";
  process.env.GITHUB_RUN_ID = "123456";
  process.env.GITHUB_RUN_ATTEMPT = "2";
  process.env.GITHUB_SERVER_URL = "https://github.com";
  process.env.OCTESTRA_AGENT_DEBUG_VALUE = "true";
});

afterEach(async () => {
  delete process.env.GITHUB_WORKSPACE;
  delete process.env.RUNNER_TEMP;
  delete process.env.OCTESTRA_AGENT_DEBUG_VALUE;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("listEpics", () => {
  it("emits an empty matrix input when no open EPIC is eligible", async () => {
    const client = {
      listOpenIssuesByLabel: vi.fn().mockResolvedValue([]),
    };

    await listEpics(client);

    expect(core.setOutput).toHaveBeenCalledWith("epics", "[]");
    expect(core.setOutput).toHaveBeenCalledWith("count", "0");
  });

  it("emits open EPICs that did not opt out of Todo triage", async () => {
    const client = {
      listOpenIssuesByLabel: vi.fn().mockResolvedValue([
        {
          number: 42,
          title: "Enabled",
          body: [
            "```epic-config",
            "id: enabled",
            "triage_skill: migration-triage",
            "validation_skill: validation",
            "```",
          ].join("\n"),
        },
        {
          number: 81,
          title: "Disabled",
          body: [
            "```epic-config",
            "id: disabled",
            "skip_triage: true",
            "validation_skill: validation",
            "```",
          ].join("\n"),
        },
      ]),
    };

    await listEpics(client);

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith("octestra-epic");
    expect(core.setOutput).toHaveBeenCalledWith(
      "epics",
      JSON.stringify([{ number: 42 }]),
    );
    expect(core.setOutput).toHaveBeenCalledWith("count", "1");
    expect(core.summary.write).toHaveBeenCalled();
  });

  it("rejects an enabled EPIC without a triage skill", async () => {
    const client = {
      listOpenIssuesByLabel: vi.fn().mockResolvedValue([
        {
          number: 42,
          title: "Missing skill",
          body: [
            "```epic-config",
            "id: missing-skill",
            "validation_skill: validation",
            "```",
          ].join("\n"),
        },
      ]),
    };

    await expect(listEpics(client)).rejects.toThrow(
      "EPIC #42 enables Todo triage but epic-config triage_skill is empty",
    );
  });

  it("rejects more EPICs than a GitHub Actions matrix supports", async () => {
    const client = {
      listOpenIssuesByLabel: vi.fn().mockResolvedValue(
        Array.from({ length: 257 }, (_, index) => ({
          number: index + 1,
          title: `EPIC ${index + 1}`,
          body: [
            "```epic-config",
            `id: epic-${index + 1}`,
            "triage_skill: migration-triage",
            "validation_skill: validation",
            "```",
          ].join("\n"),
        })),
      ),
    };

    await expect(listEpics(client)).rejects.toThrow(
      "GitHub Actions supports at most 256 matrix jobs",
    );
  });
});

describe("prepareTriage", () => {
  const defaultPromptTemplate = ".github/octestra/prompts/loop-todo.md.hbs";

  it("renders the configured EPIC triage prompt", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "loop-prompt-"));
    temporaryDirectories.push(workspace);
    process.env.GITHUB_WORKSPACE = workspace;
    process.env.RUNNER_TEMP = workspace;
    const promptDirectory = path.join(workspace, "custom/prompts");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(
      path.join(promptDirectory, "todo.hbs"),
      "Use {{triageSkill}} for EPIC #{{epicNumber}}.\n{{epicTriagePrompt}}",
    );
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        state: "open",
        labels: ["octestra-epic"],
        body: [
          "```epic-config",
          "id: migration",
          "triage_skill: migration-triage",
          "validation_skill: validation",
          "```",
          "",
          "```epic-triage-prompt",
          "Prioritize tasks that unblock other work.",
          "```",
        ].join("\n"),
      }),
    };

    await prepareTriage(
      {
        client,
        epicNumber: 42,
      },
      "custom/prompts/todo.hbs",
    );

    expect(core.setOutput).toHaveBeenCalledWith(
      "prompt",
      [
        "Use migration-triage for EPIC #42.",
        "Prioritize tasks that unblock other work.",
      ].join("\n"),
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "triage_skill",
      "migration-triage",
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "result_path",
      path.join(workspace, "octestra-triage-result.json"),
    );
    expect(core.exportVariable).toHaveBeenCalledWith(
      "OCTESTRA_AGENT_DEBUG",
      "true",
    );
  });

  it("omits the additional instructions section when the EPIC has none", async () => {
    process.env.GITHUB_WORKSPACE = path.join(process.cwd(), "templates");
    process.env.RUNNER_TEMP = tmpdir();
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        state: "open",
        labels: ["octestra-epic"],
        body: [
          "```epic-config",
          "id: migration",
          "triage_skill: migration-triage",
          "validation_skill: validation",
          "```",
        ].join("\n"),
      }),
    };

    await prepareTriage(
      {
        client,
        epicNumber: 42,
      },
      defaultPromptTemplate,
    );

    const promptCall = vi.mocked(core.setOutput).mock.calls.find(
      ([name]) => name === "prompt",
    );
    expect(promptCall?.[1]).not.toContain("Additional instructions from the EPIC");
  });

  it("requires the EPIC to configure a triage skill", async () => {
    process.env.RUNNER_TEMP = tmpdir();
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        state: "open",
        labels: ["octestra-epic"],
        body: [
          "```epic-config",
          "id: migration",
          "validation_skill: validation",
          "```",
        ].join("\n"),
      }),
    };

    await expect(prepareTriage(
      {
        client,
        epicNumber: 42,
      },
      defaultPromptTemplate,
    )).rejects.toThrow("triage_skill must be a non-empty string");
  });

  it("rejects an EPIC that opted out after discovery", async () => {
    process.env.RUNNER_TEMP = tmpdir();
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        state: "open",
        labels: ["octestra-epic"],
        body: [
          "```epic-config",
          "id: migration",
          "skip_triage: true",
          "validation_skill: validation",
          "```",
        ].join("\n"),
      }),
    };

    await expect(prepareTriage(
      {
        client,
        epicNumber: 42,
      },
      defaultPromptTemplate,
    )).rejects.toThrow("EPIC #42 has skip_triage enabled");
  });

  it("rejects an EPIC that became ineligible after discovery", async () => {
    process.env.RUNNER_TEMP = tmpdir();
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        state: "closed",
        labels: ["octestra-epic"],
        body: [
          "```epic-config",
          "id: migration",
          "triage_skill: migration-triage",
          "validation_skill: validation",
          "```",
        ].join("\n"),
      }),
    };

    await expect(prepareTriage(
      {
        client,
        epicNumber: 42,
      },
      defaultPromptTemplate,
    )).rejects.toThrow(
      "EPIC #42 is no longer an open octestra-epic issue",
    );
  });
});

function epicIssue(): {
  title: string;
  body: string;
  state: string;
  labels: string[];
} {
  return {
    title: "Migration",
    state: "open",
    labels: ["octestra-epic"],
    body: [
      "```epic-config",
      "id: migration",
      "triage_skill: migration-triage",
      "validation_skill: validation",
      "```",
    ].join("\n"),
  };
}

function taskIssue(state = "open"): {
  title: string;
  body: string;
  state: string;
  labels: string[];
} {
  return {
    title: "Task",
    state,
    labels: [],
    body: [
      "```task-config",
      "target: src/example.ts",
      "```",
    ].join("\n"),
  };
}

async function triageResultPath(readyIssues: number[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "triage-result-"));
  temporaryDirectories.push(directory);
  const resultPath = path.join(directory, "result.json");
  await writeFile(resultPath, JSON.stringify({
    kind: "triage-result",
    readyIssues,
  }));
  return resultPath;
}

describe("finalizeTriage", () => {
  it("moves Todo tasks to Ready and leaves Ready tasks unchanged", async () => {
    const resultPath = await triageResultPath([101, 102]);
    const client = {
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 42 ? epicIssue() : taskIssue()
      ),
      getParentNumber: vi.fn().mockResolvedValue(42),
      getStatus: vi.fn()
        .mockResolvedValueOnce("Todo")
        .mockResolvedValueOnce("Ready")
        .mockResolvedValueOnce("Todo")
        .mockResolvedValueOnce("Ready"),
      getLatestAssignedUser: vi.fn().mockResolvedValue("task-owner"),
      comment: vi.fn(),
      updateStatus: vi.fn(),
    };

    await finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    );

    expect(client.updateStatus).toHaveBeenCalledTimes(1);
    expect(client.updateStatus).toHaveBeenCalledWith(101, 9001, "Ready");
    expect(client.comment).toHaveBeenCalledWith(
      101,
      expect.stringContaining(
        "Todo triage selected this task from EPIC #42 and queued it for execution.",
      ),
    );
    expect(client.comment).toHaveBeenCalledWith(
      101,
      expect.stringContaining("- AI Task Status transition: `Todo` to `Ready`"),
    );
    expect(client.comment).not.toHaveBeenCalledWith(102, expect.anything());
    expect(core.setOutput).toHaveBeenCalledWith("ready_count", "1");
    expect(client.getIssue).toHaveBeenCalledWith(101);
    expect(client.getIssue).toHaveBeenCalledWith(102);
    expect(
      vi.mocked(client.getIssue).mock.invocationCallOrder[2],
    ).toBeLessThan(
      vi.mocked(client.updateStatus).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(client.comment).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(client.updateStatus).mock.invocationCallOrder[0],
    );
  });

  it("accepts an empty result without task reads or writes", async () => {
    const resultPath = await triageResultPath([]);
    const client = {
      getIssue: vi.fn().mockResolvedValue(epicIssue()),
      getParentNumber: vi.fn(),
      getStatus: vi.fn(),
      getLatestAssignedUser: vi.fn(),
      comment: vi.fn(),
      updateStatus: vi.fn(),
    };

    await finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    );

    expect(client.getIssue).toHaveBeenCalledTimes(2);
    expect(client.getParentNumber).not.toHaveBeenCalled();
    expect(client.comment).not.toHaveBeenCalled();
    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("ready_count", "0");
  });

  it("preflights every reported task before changing any status", async () => {
    const resultPath = await triageResultPath([101, 202]);
    const client = {
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 42 ? epicIssue() : taskIssue()
      ),
      getParentNumber: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 101 ? 42 : 99
      ),
      getStatus: vi.fn().mockResolvedValue("Todo"),
      getLatestAssignedUser: vi.fn(),
      comment: vi.fn(),
      updateStatus: vi.fn(),
    };

    await expect(finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    )).rejects.toThrow(
      "Reported task #202 is not a direct sub-issue of EPIC #42",
    );

    expect(client.updateStatus).not.toHaveBeenCalled();
  });

  it("does not overwrite a status that changes after preflight", async () => {
    const resultPath = await triageResultPath([101]);
    const client = {
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 42 ? epicIssue() : taskIssue()
      ),
      getParentNumber: vi.fn().mockResolvedValue(42),
      getStatus: vi.fn()
        .mockResolvedValueOnce("Todo")
        .mockResolvedValueOnce("In Progress"),
      getLatestAssignedUser: vi.fn(),
      comment: vi.fn(),
      updateStatus: vi.fn(),
    };

    await expect(finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    )).rejects.toThrow(
      "Reported task #101 changed to In Progress before update",
    );

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.comment).not.toHaveBeenCalled();
  });

  it("rechecks EPIC eligibility after task preflight", async () => {
    const resultPath = await triageResultPath([101]);
    const client = {
      getIssue: vi.fn()
        .mockResolvedValueOnce(epicIssue())
        .mockResolvedValueOnce(taskIssue())
        .mockResolvedValueOnce({
          ...epicIssue(),
          state: "closed",
        }),
      getParentNumber: vi.fn().mockResolvedValue(42),
      getStatus: vi.fn().mockResolvedValue("Todo"),
      getLatestAssignedUser: vi.fn(),
      comment: vi.fn(),
      updateStatus: vi.fn(),
    };

    await expect(finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    )).rejects.toThrow(
      "EPIC #42 is no longer an open octestra-epic issue",
    );

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.comment).not.toHaveBeenCalled();
  });

  it("rejects a reported issue without a task-config body before writes", async () => {
    const resultPath = await triageResultPath([101]);
    const client = {
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 42
          ? epicIssue()
          : {
            ...taskIssue(),
            body: "No task contract",
          }
      ),
      getParentNumber: vi.fn().mockResolvedValue(42),
      getStatus: vi.fn(),
      getLatestAssignedUser: vi.fn(),
      comment: vi.fn(),
      updateStatus: vi.fn(),
    };

    await expect(finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    )).rejects.toThrow("Reported task #101 has an invalid task body");

    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(client.comment).not.toHaveBeenCalled();
  });

  it("updates Todo tasks when activity reporting fails", async () => {
    const resultPath = await triageResultPath([101]);
    const client = {
      getIssue: vi.fn().mockImplementation(async (issueNumber: number) =>
        issueNumber === 42 ? epicIssue() : taskIssue()
      ),
      getParentNumber: vi.fn().mockResolvedValue(42),
      getStatus: vi.fn().mockResolvedValue("Todo"),
      getLatestAssignedUser: vi.fn().mockResolvedValue("task-owner"),
      comment: vi.fn().mockRejectedValue(new Error("comment failed")),
      updateStatus: vi.fn(),
    };

    await finalizeTriage(
      {
        client,
        epicNumber: 42,
        statusFieldId: 9001,
      },
      resultPath,
    );

    expect(core.warning).toHaveBeenCalledWith(
      "Failed to report Octestra activity: Error: comment failed",
    );
    expect(client.updateStatus).toHaveBeenCalledWith(101, 9001, "Ready");
  });
});
