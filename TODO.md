# TODO

## Define the agent execution trust boundary

Octestra workflows execute a repository-configured coding agent with access to repository content,
Issue instructions, dependency output, and potentially GitHub or cloud credentials. Private
repositories reduce who can supply malicious input, but do not reduce the impact after an agent or
command is compromised.

Before treating the generated workflows as safe defaults for public repositories:

- Separate agent-controlled execution from trusted lifecycle finalization.
- Use read-only checkout tokens with `persist-credentials: false`.
- Give validation agents no repository write token by default.
- If an agent must comment, issue a short-lived token limited to repository read plus Issue and pull
  request writes, then revoke it immediately after the agent finishes.
- Generate a fresh lifecycle token in a separate job that does not execute pull request code.
- Transfer validation proof to that job as bounded, strictly validated data.
- Protect the default branch with a ruleset that the task App cannot bypass. Task agents still need
  repository write access to create their dedicated branches.
- Treat OIDC roles, model credentials, network access, and persistent self-hosted runners as
  separate risks. Use isolated ephemeral runners and narrowly scoped non-production credentials.

Open decisions:

- Whether Octestra supports public consumer repositories or documents private, trusted-member
  repositories as its initial security boundary.
- Whether Claude must post comments directly, or whether trusted Octestra finalization can render
  all comments from agent-produced proof.
- Whether comment tokens should be enabled explicitly rather than included in generated defaults.
- What cloud and network isolation is required when validation uses Bedrock or another hosted model.

An initial implementation experiment is stored in the Git stash named
`wip: validation token boundary experiment`.

