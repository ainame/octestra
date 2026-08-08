# Changelog

## [0.1.1](https://github.com/ainame/octestra/compare/v0.1.0...v0.1.1) (2026-08-08)


### Bug Fixes

* require v-prefixed release tags ([#2](https://github.com/ainame/octestra/issues/2)) ([56308d2](https://github.com/ainame/octestra/commit/56308d276b831c183d8d8a03f5e2ba1bd2720cb7))

## 0.1.0 (2026-08-07)


### Features

* automate releases with Release Please ([39f46dd](https://github.com/ainame/octestra/commit/39f46dd833957269ff4ac49171f4640c951e44d1))

## Changelog

All notable changes to Octestra are documented in this file.

## Initial capabilities

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
