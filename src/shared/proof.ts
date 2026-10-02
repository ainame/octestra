import { markdownTable } from "./markdown";
import {
  parseValidationResult,
  readJsonResult,
  type ResultRow,
  type ValidationResult,
} from "./result";

type ProofRow = ResultRow;
export type ProofDocument = ValidationResult;

export interface ArtifactLink {
  url: string;
  // Shown as the link text, typically the artifact name the workflow uploaded under.
  name?: string;
}

// One artifact per line: an optional name, whitespace, then the URL. The URL is the last token
// because a URL never contains whitespace while a name may. A line whose last token is not a URL
// is skipped: a workflow that uploaded nothing passes the name with an empty URL after it.
export function parseArtifactLinks(lines: string[]): ArtifactLink[] {
  const links: ArtifactLink[] = [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    const url = tokens[tokens.length - 1];
    if (!/^https?:\/\//.test(url)) {
      continue;
    }
    const name = tokens.slice(0, -1).join(" ");
    links.push(name ? { url, name } : { url });
  }
  return links;
}

export interface ProofCommentContext {
  issueNumber: number;
  pullNumber?: number;
  subjectSha?: string;
  owner?: string;
  actor?: string;
  runUrl?: string;
  // Numeric run id, used for the download command; runUrl carries it but is not parsed.
  runId?: string;
  runAttempt?: string;
  recordedAt?: string;
  // Where the uploaded evidence (screenshots, recordings, logs) can be downloaded.
  artifactLinks?: ArtifactLink[];
  // What the reader should do with this result, e.g. how to re-run validation.
  nextSteps?: string;
}

export function parseProofDocument(raw: unknown): ProofDocument {
  return parseValidationResult(raw);
}

export async function readProofDocument(proofPath: string): Promise<ProofDocument> {
  return parseProofDocument(await readJsonResult(proofPath));
}

function valueFrom(row: ProofRow, ...keys: string[]): unknown {
  return keys.map((key) => row[key]).find((value) => value !== undefined);
}

function displayValue(value: unknown, fallback = "—"): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => displayValue(item, "")).filter(Boolean);
    return items.length > 0 ? items.join(", ") : fallback;
  }
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function escapeCell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function tableCell(value: unknown, fallback = "—"): string {
  return escapeCell(displayValue(value, fallback));
}

interface ResultStatus {
  mark: string;
  label: string;
}

function knownResultStatus(result: string): ResultStatus | undefined {
  switch (result.toLowerCase()) {
    case "passed":
    case "success":
    case "succeeded":
      return { mark: "✅", label: "Passed" };
    case "failed":
    case "failure":
      return { mark: "❌", label: "Failed" };
    case "blocked":
      return { mark: "⛔", label: "Blocked" };
    case "skipped":
    case "not_run":
    case "not run":
      return { mark: "-", label: "Skipped" };
    default:
      return undefined;
  }
}

export function resultLabel(value: unknown): string {
  const result = displayValue(value, "reported");
  const status = knownResultStatus(result);
  return status ? `${status.mark} ${status.label}` : `ℹ️ ${result}`;
}

// Table cells repeat the result on every row, where the mark alone reads at a glance. An
// unrecognised result keeps its text, since the mark says nothing about what it was.
export function resultMark(value: unknown): string {
  const result = displayValue(value, "reported");
  return knownResultStatus(result)?.mark ?? `ℹ️ ${result}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ReferenceTarget {
  pattern: string;
  link: ArtifactLink;
}

// Every uploaded file is matched by its relative path, and by its file name alone when no other
// upload shares that name, since agents often cite a screenshot by name only.
function referenceTargets(links: ArtifactLink[]): ReferenceTarget[] {
  const named = links.filter((link): link is ArtifactLink & { name: string } =>
    link.name !== undefined && link.name !== "",
  );
  const targets: ReferenceTarget[] = named.map((link) => ({ pattern: link.name, link }));
  const basenames = new Map<string, ArtifactLink[]>();
  for (const link of named) {
    const base = link.name.slice(link.name.lastIndexOf("/") + 1);
    basenames.set(base, [...(basenames.get(base) ?? []), link]);
  }
  for (const [base, owners] of basenames) {
    if (owners.length === 1 && owners[0].name !== base) {
      targets.push({ pattern: base, link: owners[0] });
    }
  }
  // Longest first, so `screens/home.png` wins over `home.png` inside the same alternation.
  return targets.sort((a, b) => b.pattern.length - a.pattern.length);
}

// Turns every mention of an uploaded file in an evidence cell into a link to it, and leaves the
// rest of the cell as the agent wrote it. A mention may carry a directory prefix, including the
// runner's absolute path, may sit inside backticks, which stay inside the link text, and may be
// followed by text without a space, as Japanese prose does. It must not be part of a longer
// name: `xhome.png` and `home.png.bak` are other files.
export function linkArtifactReferences(text: string, links: ArtifactLink[]): string {
  const targets = referenceTargets(links);
  if (targets.length === 0) {
    return text;
  }
  const byPattern = new Map(targets.map((target) => [target.pattern, target.link]));
  const alternation = targets.map((target) => escapeRegExp(target.pattern)).join("|");
  const mention = new RegExp(
    `(?<![\\w.\\-/])(\`?)((?:[\\w.\\-/]*/)?(${alternation}))(\`?)(?![\\w-]|\\.\\w)`,
    "g",
  );
  return text.replace(mention, (match, open: string, full: string, matched: string, close: string) => {
    const link = byPattern.get(matched);
    return link ? `[${open}${full}${close}](${link.url})` : match;
  });
}

// A column is a header plus the row keys it reads, most-preferred key first.
// `fallback` supplies a positional label when a row names nothing usable, `label` marks the
// columns whose value is a pass/fail result rather than text, and `references` marks the
// columns whose file names become links to uploaded artifacts.
interface ProofColumn {
  header: string;
  keys: string[];
  fallback?: (index: number) => string;
  label?: boolean;
  references?: boolean;
}

function renderProofRows(
  columns: ProofColumn[],
  rows: ProofRow[],
  links: ArtifactLink[],
): string {
  return markdownTable(
    columns.map((column) => column.header),
    rows.map((row, index) => columns.map((column) => {
      const value = valueFrom(row, ...column.keys);
      if (column.label) {
        return tableCell(resultMark(value));
      }
      const text = displayValue(value, column.fallback?.(index));
      return escapeCell(column.references ? linkArtifactReferences(text, links) : text);
    })),
  );
}

const acceptanceColumns: ProofColumn[] = [
  { header: "ID", keys: ["id"], fallback: (index) => `AC-${index + 1}` },
  { header: "Criterion", keys: ["criterion", "description", "name", "summary"] },
  { header: "Result", keys: ["result", "outcome", "status"], label: true },
  { header: "Evidence", keys: ["evidence", "evidenceRefs", "evidence_refs"], references: true },
];

const checkColumns: ProofColumn[] = [
  { header: "Check", keys: ["name", "id"], fallback: (index) => `Check ${index + 1}` },
  { header: "Type", keys: ["type", "kind"] },
  { header: "Scope", keys: ["scope"] },
  { header: "Result", keys: ["result", "outcome", "status"], label: true },
  { header: "Evidence", keys: ["evidence", "evidenceRefs", "evidence_refs"], references: true },
];

const evidenceColumns: ProofColumn[] = [
  { header: "Evidence", keys: ["name", "id"], fallback: (index) => `Evidence ${index + 1}` },
  { header: "Type", keys: ["type", "kind"] },
  { header: "Reference", keys: ["reference", "url", "link", "path"], references: true },
];

// With a run URL the row points at the run's artifact list (the summary page's `artifacts`
// anchor, checked against a live run page), where every file has its own download button;
// listing each link here would make the cell unreadable past a few files. Without one, the
// links themselves are the only way to reach the files.
function renderArtifactsCell(links: ArtifactLink[], runUrl: string | undefined): string {
  if (runUrl) {
    const noun = links.length === 1 ? "file" : "files";
    return `[${links.length} ${noun}](${runUrl}#artifacts)`;
  }
  return links
    .map((link, index) => {
      const fallback = links.length === 1 ? "Artifact" : `Artifact ${index + 1}`;
      return `[${tableCell(link.name, fallback)}](${link.url})`;
    })
    .join(" · ");
}

// `gh run download` cannot fetch non-archived artifacts (cli/cli#13012), so the installed
// maintenance script does it through the API.
function renderDownloadCommand(runId: string): string {
  return [
    "Download all files from a checkout of this repository:",
    "",
    "```sh",
    `.github/octestra/octestra.sh artifacts ${runId}`,
    "```",
  ].join("\n");
}

export function renderProofComment(
  proof: ProofDocument,
  context: ProofCommentContext,
): string {
  const artifactLinks = context.artifactLinks ?? [];
  // Reviewers see the result and evidence first. Execution metadata remains available
  // for auditing without making the default comment difficult to scan.
  const overviewRows = [
    context.pullNumber ? ["Pull request", `#${context.pullNumber}`] : undefined,
    context.subjectSha
      ? ["Validated commit", `\`${tableCell(context.subjectSha.slice(0, 12))}\``]
      : undefined,
    ["Outcome", resultLabel(proof.outcome)],
    proof.knownGaps
      ? ["Known gaps", proof.knownGaps.length === 0 ? "None" : String(proof.knownGaps.length)]
      : undefined,
    // The evidence table lists what the agent saved; this row is where to get it. It stays in
    // the overview because reaching it through the workflow run link in the metadata takes several
    // clicks.
    artifactLinks.length > 0
      ? ["Artifacts", renderArtifactsCell(artifactLinks, context.runUrl)]
      : undefined,
  ].filter((row): row is string[] => row !== undefined);
  const evidence = [...(proof.evidence ?? []), ...(proof.artifacts ?? [])];
  const metadataRows = [
    ["Issue", `#${context.issueNumber}`],
    context.pullNumber ? ["Pull request", `#${context.pullNumber}`] : undefined,
    context.subjectSha ? ["Subject SHA", `\`${tableCell(context.subjectSha)}\``] : undefined,
    context.runUrl ? ["Workflow run", `[View run](${context.runUrl})`] : undefined,
    context.runAttempt ? ["Run attempt", tableCell(context.runAttempt)] : undefined,
    context.actor ? ["Actor", `@${tableCell(context.actor)}`] : undefined,
    ["Task owner", context.owner ? `@${tableCell(context.owner)}` : "Unassigned"],
    ["Recorded at", tableCell(context.recordedAt ?? new Date().toISOString())],
  ].filter((row): row is string[] => row !== undefined);

  const sections = [
    "<!-- octestra-proof-of-work -->",
    `## ${resultLabel(proof.outcome)} validation proof`,
    "",
    proof.summary,
    "",
    markdownTable(["Target", "Result"], overviewRows),
  ];

  if (artifactLinks.length > 0 && context.runId) {
    sections.push("", renderDownloadCommand(context.runId));
  }
  if (proof.acceptance?.length) {
    sections.push(
      "",
      "### Acceptance criteria",
      "",
      renderProofRows(acceptanceColumns, proof.acceptance, artifactLinks),
    );
  }
  if (proof.checks?.length) {
    sections.push("", "### Checks", "", renderProofRows(checkColumns, proof.checks, artifactLinks));
  }
  if (evidence.length) {
    sections.push("", "### Evidence", "", renderProofRows(evidenceColumns, evidence, artifactLinks));
  }
  if (proof.knownGaps?.length) {
    sections.push(
      "",
      "### Known gaps",
      "",
      proof.knownGaps.map((gap) => `- ${gap}`).join("\n"),
    );
  }
  if (context.nextSteps) {
    sections.push("", "### Next steps", "", context.nextSteps);
  }
  if (proof.details) {
    sections.push(
      "",
      "<details>",
      "<summary>Additional details</summary>",
      "",
      proof.details,
      "",
      "</details>",
    );
  }

  sections.push(
    "",
    "<details>",
    "<summary>Technical metadata</summary>",
    "",
    markdownTable(["Field", "Value"], metadataRows),
    "",
    "</details>",
  );
  return sections.join("\n");
}
