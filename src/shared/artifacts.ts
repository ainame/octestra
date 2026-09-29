import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactLink } from "./proof";

// The subset of @actions/artifact's client that uploading needs, so tests can fake it.
export interface ArtifactUploader {
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
    options?: { skipArchive?: boolean },
  ): Promise<{ id?: number }>;
}

// GitHub rejects the 501st artifact of a job, so anything past this is skipped with a warning
// rather than failing the whole upload.
export const artifactUploadLimit = 500;

const uploadConcurrency = 4;

export interface UploadArtifactsOptions {
  // Directory whose files are uploaded one artifact each; missing or empty uploads nothing.
  artifactPath: string;
  // Optional single file uploaded beside the directory, such as the validation result JSON.
  resultPath?: string;
  uploader: ArtifactUploader;
  // Workflow run URL; each artifact URL is `<runUrl>/artifacts/<id>`.
  runUrl: string;
  // Where files are hard-linked or copied under their artifact name before upload. Defaults to
  // a fresh directory under RUNNER_TEMP.
  stagingDirectory?: string;
  limit?: number;
}

export interface UploadArtifactsResult {
  links: ArtifactLink[];
  // Files past the limit, by their relative path.
  skipped: string[];
  // Files whose upload failed, by their relative path.
  failed: string[];
}

interface UploadCandidate {
  // Path relative to the artifact directory; this is the link text reviewers see.
  name: string;
  absolutePath: string;
}

// Hidden entries are left out, as actions/upload-artifact does by default: a `.DS_Store` or a
// tool's dot-directory is never evidence, and a dotfile is where secrets tend to live. A symlink
// is followed when it points at a file, so an agent's `latest.png -> 03-final.png` uploads.
async function collectFiles(directory: string, prefix: string): Promise<UploadCandidate[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates: UploadCandidate[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      core.info(`Skipping hidden entry ${prefix ? `${prefix}/` : ""}${entry.name}`);
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      candidates.push(...await collectFiles(absolutePath, name));
    } else if (entry.isFile() || (entry.isSymbolicLink() && await isFile(absolutePath))) {
      candidates.push({ name, absolutePath });
    }
  }
  return candidates;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

// A non-archived upload is named after the file itself, so the file is staged under the name
// the artifact should carry. GitHub forbids these characters in artifact names, and a path
// separator would make the staged name a nested path, so both become `-` or `--`.
export function artifactNameFor(relativePath: string, taken: Set<string>): string {
  const base = relativePath
    .split("/")
    .map((segment) => segment.replace(/["<>|*?:\r\n\\]/g, "-"))
    .join("--");
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    const extension = path.extname(base);
    candidate = `${base.slice(0, base.length - extension.length)}-${counter}${extension}`;
    counter += 1;
  }
  taken.add(candidate);
  return candidate;
}

// A copy rather than a hard link: copyFile follows a symlink and works across file systems.
async function stage(
  candidate: UploadCandidate,
  stagingDirectory: string,
  artifactName: string,
): Promise<string> {
  const staged = path.join(stagingDirectory, artifactName);
  await fs.copyFile(candidate.absolutePath, staged);
  return staged;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function drain(): Promise<void> {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => drain());
  await Promise.all(workers);
}

// Uploads every file under artifactPath, and the result file when given, as its own
// non-archived artifact so a browser opens each one directly. Nothing here throws: this runs
// after the agent with `if: always()`, and the finalize step that posts the proof comment has
// no such guard, so any failure is reported and counted instead of failing the step.
export async function uploadArtifacts(
  options: UploadArtifactsOptions,
): Promise<UploadArtifactsResult> {
  try {
    return await uploadArtifactsOrThrow(options);
  } catch (error) {
    core.warning(`Could not upload the validation artifacts: ${String(error)}`);
    return { links: [], skipped: [], failed: [] };
  }
}

async function uploadArtifactsOrThrow(
  options: UploadArtifactsOptions,
): Promise<UploadArtifactsResult> {
  const candidates: UploadCandidate[] = [];
  if (await isDirectory(options.artifactPath)) {
    candidates.push(...await collectFiles(options.artifactPath, ""));
  } else {
    core.info(`No artifact directory at ${options.artifactPath}; nothing to upload from it.`);
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  if (options.resultPath && await isFile(options.resultPath)) {
    candidates.push({
      name: path.basename(options.resultPath),
      absolutePath: options.resultPath,
    });
  }

  const limit = options.limit ?? artifactUploadLimit;
  const selected = candidates.slice(0, limit);
  const skipped = candidates.slice(limit).map((candidate) => candidate.name);
  if (skipped.length > 0) {
    core.warning(
      `Uploading the first ${limit} of ${candidates.length} files; GitHub allows ${limit} artifacts per job.`,
    );
  }
  if (selected.length === 0) {
    return { links: [], skipped, failed: [] };
  }

  const stagingDirectory = options.stagingDirectory
    ?? await fs.mkdtemp(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "octestra-artifacts-"));
  await fs.mkdir(stagingDirectory, { recursive: true });
  const taken = new Set<string>();
  const plan = selected.map((candidate) => ({
    candidate,
    artifactName: artifactNameFor(candidate.name, taken),
  }));

  // Keyed by the artifact name, which is unique; two candidates may share a relative name when
  // the result file has the same name as a file the agent saved.
  const links = new Map<string, ArtifactLink>();
  const failed: string[] = [];
  await runWithConcurrency(plan, uploadConcurrency, async ({ candidate, artifactName }) => {
    try {
      const staged = await stage(candidate, stagingDirectory, artifactName);
      const response = await options.uploader.uploadArtifact(
        artifactName,
        [staged],
        stagingDirectory,
        { skipArchive: true },
      );
      if (response.id === undefined) {
        throw new Error("upload returned no artifact id");
      }
      links.set(artifactName, {
        name: candidate.name,
        url: `${options.runUrl}/artifacts/${response.id}`,
      });
    } catch (error) {
      failed.push(candidate.name);
      core.warning(`Could not upload ${candidate.name}: ${String(error)}`);
    }
  });

  // Keep the planned order so the comment lists files the way the agent numbered them.
  const ordered = plan
    .map(({ artifactName }) => links.get(artifactName))
    .filter((link): link is ArtifactLink => link !== undefined);
  core.info(`Uploaded ${ordered.length} of ${selected.length} files as artifacts.`);
  return { links: ordered, skipped, failed };
}

// The `artifact_links` output and input share one format: one `<name> <url>` line per file.
export function formatArtifactLinks(links: ArtifactLink[]): string {
  return links.map((link) => (link.name ? `${link.name} ${link.url}` : link.url)).join("\n");
}
