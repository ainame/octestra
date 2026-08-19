# Changelog

## [0.2.3](https://github.com/ainame/octestra/compare/v0.2.2...v0.2.3) (2026-08-19)


### Bug Fixes

* rename workflow contract skill ([#11](https://github.com/ainame/octestra/issues/11)) ([f0e6037](https://github.com/ainame/octestra/commit/f0e6037f53ff13efd47eecc2a1ef37ac1530dacc))

## [0.2.2](https://github.com/ainame/octestra/compare/v0.2.1...v0.2.2) (2026-08-19)


### Bug Fixes

* make Todo triage prompt configurable ([#9](https://github.com/ainame/octestra/issues/9)) ([c58c3fd](https://github.com/ainame/octestra/commit/c58c3fd1124bf1d385444b4744b1b48d8c1a5e80))

## [0.2.1](https://github.com/ainame/octestra/compare/v0.2.0...v0.2.1) (2026-08-19)


### Bug Fixes

* record Todo triage activity ([#7](https://github.com/ainame/octestra/issues/7)) ([8f11af3](https://github.com/ainame/octestra/commit/8f11af3ed2db5c2bb5ad17491061e003c3fb031d))

## [0.2.0](https://github.com/ainame/octestra/compare/v0.1.1...v0.2.0) (2026-08-19)


### Features

* add generic Octestra workflow contracts ([#6](https://github.com/ainame/octestra/issues/6)) ([bc18d3c](https://github.com/ainame/octestra/commit/bc18d3c30a002851ab11d1b6812e2776db0e8412))
* add skill-driven Todo loop ([#4](https://github.com/ainame/octestra/issues/4)) ([5d34f90](https://github.com/ainame/octestra/commit/5d34f900d68b9273c465cb1d4fe4f0a3d701a464))

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
