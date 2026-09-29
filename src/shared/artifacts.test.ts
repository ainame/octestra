import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactNameFor,
  formatArtifactLinks,
  uploadArtifacts,
  type ArtifactUploader,
} from "./artifacts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

interface RecordedUpload {
  name: string;
  files: string[];
  rootDirectory: string;
  options: { skipArchive?: boolean } | undefined;
}

function createUploader(
  behaviour: (name: string) => Promise<{ id?: number }> = async (name) => ({
    id: 100 + name.length,
  }),
): ArtifactUploader & { uploads: RecordedUpload[] } {
  const uploads: RecordedUpload[] = [];
  return {
    uploads,
    async uploadArtifact(name, files, rootDirectory, options) {
      uploads.push({ name, files, rootDirectory, options });
      return behaviour(name);
    },
  };
}

async function evidenceDirectory(): Promise<string> {
  const directory = await scratch("evidence-");
  await mkdir(path.join(directory, "frames"), { recursive: true });
  await writeFile(path.join(directory, "01-home.png"), "png-1");
  await writeFile(path.join(directory, "journey.mp4"), "mp4");
  await writeFile(path.join(directory, "frames", "frame-01.png"), "png-frame");
  return directory;
}

describe("artifactNameFor", () => {
  it("flattens directories and replaces characters GitHub rejects", () => {
    const taken = new Set<string>();

    expect(artifactNameFor("frames/frame-01.png", taken)).toBe("frames--frame-01.png");
    expect(artifactNameFor('odd:name"<1>.log', taken)).toBe("odd-name--1-.log");
  });

  it("numbers a name that is already taken", () => {
    const taken = new Set<string>();

    expect(artifactNameFor("a/x.png", taken)).toBe("a--x.png");
    expect(artifactNameFor("a/x.png", taken)).toBe("a--x-2.png");
    expect(artifactNameFor("a/x.png", taken)).toBe("a--x-3.png");
  });
});

describe("uploadArtifacts", () => {
  it("uploads every file unarchived under its relative path and links it", async () => {
    const artifactPath = await evidenceDirectory();
    const resultPath = path.join(await scratch("result-"), "validation-result.json");
    await writeFile(resultPath, "{}");
    const staging = await scratch("staging-");
    const uploader = createUploader();

    const result = await uploadArtifacts({
      artifactPath,
      resultPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      stagingDirectory: staging,
    });

    expect(result.links).toEqual([
      { name: "01-home.png", url: "https://github.com/example-org/consumer/actions/runs/1/artifacts/111" },
      {
        name: "frames/frame-01.png",
        url: "https://github.com/example-org/consumer/actions/runs/1/artifacts/120",
      },
      { name: "journey.mp4", url: "https://github.com/example-org/consumer/actions/runs/1/artifacts/111" },
      {
        name: "validation-result.json",
        url: "https://github.com/example-org/consumer/actions/runs/1/artifacts/122",
      },
    ]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    const byName = new Map(uploader.uploads.map((upload) => [upload.name, upload]));
    const frame = byName.get("frames--frame-01.png");
    expect(frame).toBeDefined();
    expect(frame?.options).toEqual({ skipArchive: true });
    expect(frame?.rootDirectory).toBe(staging);
    expect(frame?.files).toEqual([path.join(staging, "frames--frame-01.png")]);
    expect(await readFile(path.join(staging, "frames--frame-01.png"), "utf8")).toBe("png-frame");
  });

  it("reports a failed upload and keeps the others", async () => {
    const artifactPath = await evidenceDirectory();
    const uploader = createUploader(async (name) => {
      if (name === "journey.mp4") {
        throw new Error("blob storage refused");
      }
      return { id: 7 };
    });

    const result = await uploadArtifacts({
      artifactPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      stagingDirectory: await scratch("staging-"),
    });

    expect(result.links.map((link) => link.name)).toEqual(["01-home.png", "frames/frame-01.png"]);
    expect(result.failed).toEqual(["journey.mp4"]);
  });

  it("stops at the artifact limit and names what it skipped", async () => {
    const artifactPath = await evidenceDirectory();
    const uploader = createUploader();

    const result = await uploadArtifacts({
      artifactPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      stagingDirectory: await scratch("staging-"),
      limit: 2,
    });

    expect(result.links.map((link) => link.name)).toEqual(["01-home.png", "frames/frame-01.png"]);
    expect(result.skipped).toEqual(["journey.mp4"]);
    expect(uploader.uploads).toHaveLength(2);
  });

  it("uploads nothing when the directory is missing or empty", async () => {
    const uploader = createUploader();

    const missing = await uploadArtifacts({
      artifactPath: path.join(await scratch("gone-"), "never-created"),
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
    });
    const empty = await uploadArtifacts({
      artifactPath: await scratch("empty-"),
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
    });

    expect(missing.links).toEqual([]);
    expect(empty.links).toEqual([]);
    expect(uploader.uploads).toHaveLength(0);
  });

  it("skips hidden entries and follows a symlink to a file", async () => {
    const artifactPath = await evidenceDirectory();
    await writeFile(path.join(artifactPath, ".DS_Store"), "finder");
    await mkdir(path.join(artifactPath, ".cache"));
    await writeFile(path.join(artifactPath, ".cache", "index"), "cache");
    await symlink(path.join(artifactPath, "01-home.png"), path.join(artifactPath, "latest.png"));
    await symlink(path.join(artifactPath, "frames"), path.join(artifactPath, "frames-link"));
    const staging = await scratch("staging-");
    const uploader = createUploader();

    const result = await uploadArtifacts({
      artifactPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      stagingDirectory: staging,
    });

    expect(result.links.map((link) => link.name)).toEqual([
      "01-home.png",
      "frames/frame-01.png",
      "journey.mp4",
      "latest.png",
    ]);
    expect(await readFile(path.join(staging, "latest.png"), "utf8")).toBe("png-1");
  });

  it("keeps both links when the result file shares a name with an evidence file", async () => {
    const artifactPath = await evidenceDirectory();
    await writeFile(path.join(artifactPath, "result.json"), "agent copy");
    const resultPath = path.join(await scratch("result-"), "result.json");
    await writeFile(resultPath, "{}");
    const uploader = createUploader(async (name) => ({ id: name === "result.json" ? 1 : 2 }));

    const result = await uploadArtifacts({
      artifactPath,
      resultPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      stagingDirectory: await scratch("staging-"),
    });

    expect(result.links.filter((link) => link.name === "result.json")).toEqual([
      { name: "result.json", url: "https://github.com/example-org/consumer/actions/runs/1/artifacts/1" },
      { name: "result.json", url: "https://github.com/example-org/consumer/actions/runs/1/artifacts/2" },
    ]);
    expect(uploader.uploads.map((upload) => upload.name)).toContain("result-2.json");
  });

  it("reports an unexpected error instead of throwing", async () => {
    const artifactPath = await evidenceDirectory();
    const uploader = createUploader();

    const result = await uploadArtifacts({
      artifactPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      // A file where the staging directory must be created makes mkdir fail.
      stagingDirectory: path.join(artifactPath, "01-home.png"),
    });

    expect(result).toEqual({ links: [], skipped: [], failed: [] });
    expect(uploader.uploads).toHaveLength(0);
  });

  it("treats an upload without an id as failed", async () => {
    const artifactPath = await evidenceDirectory();
    const uploader = createUploader(async () => ({}));

    const result = await uploadArtifacts({
      artifactPath,
      uploader,
      runUrl: "https://github.com/example-org/consumer/actions/runs/1",
      stagingDirectory: await scratch("staging-"),
    });

    expect(result.links).toEqual([]);
    expect(result.failed).toHaveLength(3);
  });
});

describe("formatArtifactLinks", () => {
  it("writes one name and URL per line, and a bare URL when unnamed", () => {
    expect(formatArtifactLinks([
      { name: "frames/frame 01.png", url: "https://example.test/1" },
      { url: "https://example.test/2" },
    ])).toBe("frames/frame 01.png https://example.test/1\nhttps://example.test/2");
  });
});
