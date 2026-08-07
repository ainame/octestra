# Changelog

All notable changes to Octestra are documented in this file.

## [v0.1.0]

### Added

- Issue-driven task lifecycle on GitHub Actions: `Todo`, `Ready`, `In Progress`,
  `Validation`, `Human Review`, `Blocked`, and `Done`.
- Installed issue templates and Handlebars prompts for EPICs and task issues.
- Consumer-owned composite actions for implementation and validation agents, with GitHub App
  authentication and lifecycle context supplied by Octestra.
- Validation proof handling: agents write structured JSON results, which Octestra reports on the
  task issue and uses to advance or block the task.
- Support for draft pull requests and per-EPIC validation opt-out.
- Installed maintenance CLI for configuration checks, repository-variable synchronization,
  release updates, and action-reference changes.
- Release automation with immutable `vMAJOR.MINOR.PATCH` tags and a moving `vMAJOR` tag for
  GitHub Actions consumers.
