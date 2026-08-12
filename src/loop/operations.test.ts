import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { prepareRun } from "./operations";

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return {
    ...actual,
    setOutput: vi.fn(),
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
});

afterEach(async () => {
  delete process.env.GITHUB_WORKSPACE;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("prepareRun", () => {
  it("renders caller context with stable loop paths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "loop-prompt-"));
    temporaryDirectories.push(workspace);
    process.env.GITHUB_WORKSPACE = workspace;
    await writeFile(
      path.join(workspace, "triage.md.hbs"),
      "Use {{triageSkill}} for EPIC #{{epicNumber}}.\n{{epicTriagePrompt}}\nWrite {{resultPath}}.\nArtifacts: {{artifactPath}}.",
    );
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
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

    await prepareRun(
      {
        client,
        epicNumber: 42,
      },
      "todo",
      "triage.md.hbs",
      JSON.stringify({ dryRun: true }),
    );

    expect(core.setOutput).toHaveBeenCalledWith(
      "prompt",
      [
        "Use migration-triage for EPIC #42.",
        "Prioritize tasks that unblock other work.",
        "Write octestra-loop-todo.md.",
        "Artifacts: octestra-loop-todo-artifacts.",
      ].join("\n"),
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "triage_skill",
      "migration-triage",
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "result_path",
      "octestra-loop-todo.md",
    );
    expect(core.setOutput).toHaveBeenCalledWith(
      "artifact_path",
      "octestra-loop-todo-artifacts",
    );
  });

  it("rejects context that overrides framework paths", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        body: [
          "```epic-config",
          "id: migration",
          "triage_skill: migration-triage",
          "validation_skill: validation",
          "```",
        ].join("\n"),
      }),
    };

    await expect(prepareRun(
      {
        client,
        epicNumber: 42,
      },
      "todo",
      "triage.md.hbs",
      JSON.stringify({ resultPath: "/tmp/result.json" }),
    )).rejects.toThrow("cannot override resultPath");
  });

  it("requires the EPIC to configure a triage skill", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        title: "Migration",
        body: [
          "```epic-config",
          "id: migration",
          "validation_skill: validation",
          "```",
        ].join("\n"),
      }),
    };

    await expect(prepareRun(
      {
        client,
        epicNumber: 42,
      },
      "todo",
      "triage.md.hbs",
      "",
    )).rejects.toThrow("triage_skill must be a non-empty string");
  });
});
