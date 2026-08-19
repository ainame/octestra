import * as core from "@actions/core";
import { markdownTable } from "./markdown";
import { workflowRunUrl } from "./workflow-run";

export interface ActivityClient {
  comment(issueNumber: number, body: string): Promise<void>;
  getLatestAssignedUser(issueNumber: number): Promise<string | undefined>;
}

export interface ActivityContext {
  client: ActivityClient;
  issueNumber: number;
}

export interface ActivityReport {
  status: string;
  outcome: string;
  summary: string;
  details?: string;
}

export async function reportActivity(
  context: ActivityContext,
  activity: ActivityReport,
): Promise<void> {
  if (!activity.status || !activity.outcome || !activity.summary) {
    throw new Error("Activity status, outcome, and summary are required");
  }

  const owner = await context.client.getLatestAssignedUser(context.issueNumber);
  const actor = process.env.GITHUB_ACTOR;
  const runUrl = workflowRunUrl();
  const metadata = markdownTable(["Field", "Value"], [
    ["Workflow run", `[View run](${runUrl})`],
    ["Trigger actor", actor ? `@${actor}` : "N/A"],
    ["Task owner", owner ? `@${owner}` : "Unassigned"],
    ["Recorded at", new Date().toISOString()],
  ]);
  const details = activity.details?.trim()
    ? `\n\n### Details\n\n${activity.details.trim()}`
    : "";

  await context.client.comment(
    context.issueNumber,
    [
      "<!-- octestra-activity -->",
      "## Octestra activity",
      "",
      activity.summary.trim(),
      "",
      "| Status | Outcome |",
      "| --- | --- |",
      `| \`${activity.status}\` | \`${activity.outcome}\` |`,
      details,
      "",
      "<details>",
      "<summary>Technical metadata</summary>",
      "",
      metadata,
      "",
      "</details>",
    ].join("\n"),
  );
}

export async function reportActivitySafely(
  context: ActivityContext,
  activity: ActivityReport,
): Promise<void> {
  try {
    await reportActivity(context, activity);
  } catch (error) {
    core.warning(`Failed to report Octestra activity: ${String(error)}`);
  }
}
