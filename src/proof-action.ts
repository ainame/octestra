import * as core from "@actions/core";
import { reportProof, type ProofContext } from "./lifecycle/operations";
import { GitHubClient } from "./shared/github-client";
import { positiveInteger } from "./shared/validate";

function positiveIntegerInput(name: string, required: boolean): number | undefined {
  const raw = core.getInput(name, { required });
  if (!raw && !required) {
    return undefined;
  }
  return positiveInteger(name, raw);
}

export async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const issueNumber = positiveIntegerInput("issue-number", true)!;
  const context: ProofContext = {
    client: new GitHubClient(token),
    issueNumber,
  };

  // The dedicated Action is a convenient wrapper around the same public operation.
  // It reports proof only; lifecycle policy remains in finalize-validation or the
  // consumer's own composition of individual operations.
  await reportProof(context, core.getInput("proof-path", { required: true }), {
    pullNumber: positiveIntegerInput("pull-number", false),
  });
}

if (require.main === module) {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
