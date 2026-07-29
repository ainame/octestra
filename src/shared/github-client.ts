import { getOctokit } from "@actions/github";

interface IssueField {
  id: number;
  name: string;
  data_type: string;
}

interface IssueFieldValue {
  field_id: number;
  value: string;
}

interface CurrentIssueFieldValue {
  issue_field_name?: string;
  single_select_option?: {
    name?: string;
  } | null;
}

interface IssueEvent {
  event?: string;
  assignee?: {
    login?: string;
    type?: string;
  } | null;
}

interface TimelineEvent {
  event?: string;
  source?: {
    issue?: {
      number?: number;
      pull_request?: object;
      state?: string;
    };
  };
}

const mergeClosureWindowMilliseconds = 60_000;

const perPage = 100;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export class GitHubClient {
  private readonly octokit: ReturnType<typeof getOctokit>;
  private readonly assignedUsers = new Map<number, { login: string | undefined }>();
  private readonly singleSelectFields = new Map<string, IssueField>();
  readonly owner: string;
  readonly repo: string;

  constructor(token: string, repository = process.env.GITHUB_REPOSITORY) {
    if (!repository) {
      throw new Error("GITHUB_REPOSITORY must be set");
    }

    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repository: ${repository}`);
    }

    this.owner = owner;
    this.repo = repo;
    this.octokit = getOctokit(token);
  }

  async getContent(path: string, ref?: string): Promise<string> {
    const response = await this.octokit.rest.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
    if (Array.isArray(response.data) || response.data.type !== "file" || !response.data.content) {
      throw new Error(`Config path is not a file: ${path}`);
    }
    return Buffer.from(response.data.content, "base64").toString("utf8");
  }

  async getIssue(issueNumber: number): Promise<{ title: string; body: string }> {
    const response = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return {
      title: response.data.title,
      body: response.data.body ?? "",
    };
  }

  async isClosedByMergedPullRequest(issueNumber: number): Promise<boolean> {
    const issue = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    if (issue.data.state !== "closed" || !issue.data.closed_at) {
      return false;
    }

    const linkedPullNumbers = await this.crossReferencedPullNumbers(issueNumber);

    for (const pullNumber of linkedPullNumbers) {
      const pull = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });
      if (
        pull.data.merged_at &&
        Math.abs(
          Date.parse(issue.data.closed_at) - Date.parse(pull.data.merged_at),
        ) <= mergeClosureWindowMilliseconds
      ) {
        return true;
      }
    }
    return false;
  }

  async getParentNumber(issueNumber: number): Promise<number> {
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/parent",
        {
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
        },
      );
      const parent = response.data as { number?: number };
      if (!parent.number) {
        throw new Error("Parent issue response did not contain an issue number");
      }
      return parent.number;
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error("No parent issue found. This workflow only runs on sub-issues.");
      }
      throw error;
    }
  }

  async getUserDisplayName(login: string): Promise<string> {
    const response = await this.octokit.rest.users.getByUsername({ username: login });
    return response.data.name?.trim() || response.data.login;
  }

  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branchName}`,
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  async findOpenPullRequest(branchName: string): Promise<number | undefined> {
    const response = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: `${this.owner}:${branchName}`,
      per_page: 1,
    });
    return response.data[0]?.number;
  }

  async assignIssue(issueNumber: number, assignee: string): Promise<void> {
    await this.octokit.rest.issues.addAssignees({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      assignees: [assignee],
    });
  }

  async markPullRequestReadyForReview(pullNumber: number): Promise<void> {
    // The mutation below fails on a pull request that is already ready, which is the
    // common case now that `draft_pr` defaults to false, so read the state first.
    const pull = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: pullNumber,
    });
    if (!pull.data.draft) {
      return;
    }

    // GraphQL-only: `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` has no writable
    // `draft` field, so REST can open a draft but cannot take one out of draft.
    await this.octokit.graphql(
      `mutation($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            isDraft
          }
        }
      }`,
      {
        pullRequestId: pull.data.node_id,
      },
    );
  }

  async requestReviewer(pullNumber: number, reviewer: string): Promise<void> {
    await this.octokit.rest.pulls.requestReviewers({
      owner: this.owner,
      repo: this.repo,
      pull_number: pullNumber,
      reviewers: [reviewer],
    });
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  // Every finalize resolves the same owner at least twice, and each resolution
  // paginates the issue's whole event history. One action step is one process,
  // so caching for the life of the client cannot go stale within a run.
  async getLatestAssignedUser(issueNumber: number): Promise<string | undefined> {
    const cached = this.assignedUsers.get(issueNumber);
    if (cached !== undefined) {
      return cached.login;
    }
    const login = await this.fetchLatestAssignedUser(issueNumber);
    this.assignedUsers.set(issueNumber, { login });
    return login;
  }

  private async fetchLatestAssignedUser(issueNumber: number): Promise<string | undefined> {
    const events = await this.octokit.paginate(
      this.octokit.rest.issues.listEvents,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      },
    ) as IssueEvent[];

    return events
      .filter(
        (event) =>
          event.event === "assigned" &&
          event.assignee?.type === "User" &&
          event.assignee.login,
      )
      .at(-1)
      ?.assignee
      ?.login;
  }

  async findLinkedOpenPullRequest(
    issueNumber: number,
    headBranch?: string,
  ): Promise<number | undefined> {
    const pullNumbers = (await this.crossReferencedPullNumbers(
      issueNumber,
      (event) => event.source?.issue?.state === "open",
    )).reverse();

    if (!headBranch) {
      return pullNumbers[0];
    }

    for (const pullNumber of pullNumbers) {
      const pull = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });
      if (
        pull.data.head.ref === headBranch &&
        pull.data.head.repo?.full_name === `${this.owner}/${this.repo}`
      ) {
        return pullNumber;
      }
    }
    return undefined;
  }

  // Only the linked pull request numbers are retained. Mapping each page down
  // before moving on keeps a long issue's full timeline payload from being held
  // in memory all at once.
  private async crossReferencedPullNumbers(
    issueNumber: number,
    accept: (event: TimelineEvent) => boolean = () => true,
  ): Promise<number[]> {
    const pullNumbers: number[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
        {
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          page,
          per_page: perPage,
          headers: {
            accept: "application/vnd.github+json",
          },
        },
      );
      const events = response.data as TimelineEvent[];
      pullNumbers.push(
        ...events
          .filter(
            (event) =>
              event.event === "cross-referenced" &&
              event.source?.issue?.pull_request &&
              event.source.issue.number &&
              accept(event),
          )
          .map((event) => event.source?.issue?.number)
          .filter((pullNumber): pullNumber is number => pullNumber !== undefined),
      );
      if (events.length < perPage) {
        return pullNumbers;
      }
    }
  }

  async updateStatus(issueNumber: number, fieldName: string, status: string): Promise<void> {
    const field = await this.getSingleSelectField(fieldName);
    const issueFieldValues: IssueFieldValue[] = [{ field_id: field.id, value: status }];
    await this.octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values",
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        issue_field_values: issueFieldValues,
        headers: {
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
  }

  async getStatus(issueNumber: number, fieldName: string): Promise<string | undefined> {
    const response = await this.octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values",
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        headers: {
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
    const values = response.data as CurrentIssueFieldValue[];
    return values.find((value) => value.issue_field_name === fieldName)
      ?.single_select_option
      ?.name;
  }

  // Lists the organization's fields, because there is no endpoint for a single one.
  // Memoized because one action step is one process, so a step that writes status
  // more than once pays for this lookup only on the first write.
  private async getSingleSelectField(fieldName: string): Promise<IssueField> {
    const cached = this.singleSelectFields.get(fieldName);
    if (cached) {
      return cached;
    }
    const fieldsResponse = await this.octokit.request("GET /orgs/{org}/issue-fields", {
      org: this.owner,
      headers: {
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    const fields = fieldsResponse.data as IssueField[];
    const field = fields.find(
      (candidate) => candidate.name === fieldName && candidate.data_type === "single_select",
    );
    if (!field) {
      throw new Error(`Single-select issue field not found: ${fieldName}`);
    }
    this.singleSelectFields.set(fieldName, field);
    return field;
  }
}
