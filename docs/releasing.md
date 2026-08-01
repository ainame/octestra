# Releasing Octestra

Octestra releases are published by `.github/workflows/release.yml`. A release has two tags:

- An immutable, annotated `MAJOR.MINOR.PATCH` tag, such as `0.0.1`.
- A moving `MAJOR` tag, such as `0`, for consumers that deliberately follow compatible releases.

Neither tag has a `v` prefix. The installer and installed maintenance script consider only numeric
tags when they resolve the newest release.

## Prepare

1. Change the version in `package.json` and `package-lock.json` in the release pull request.
2. Run `make all` and commit the rebuilt `dist/index.js` if it changed.
3. Merge the pull request and wait for CI on the default branch to pass.

The workflow refuses a version that does not exactly match `package.json`, a version that is not
newer than the latest release tag, or a run dispatched from anything except the latest default
branch commit.

## Publish

Run the workflow from the default branch with the same version:

```sh
gh workflow run release.yml --ref main -f version=0.0.1
```

The workflow runs `make all` again, checks that the build left no uncommitted changes, creates the
annotated version tag, moves the major tag, and publishes a GitHub release with generated notes.
No npm package or separate archive is published; GitHub supplies source archives for the release,
and the committed `dist/index.js` is the executable action bundle.

If the workflow stops after pushing the tags but before publishing the GitHub release, rerun the
same version. It may reuse an annotated version tag only when that tag points to the same commit and
no release exists. Once the GitHub release exists, the workflow refuses to publish it again.
