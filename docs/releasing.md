# Releasing Octestra

Octestra releases are managed by [Release Please](https://github.com/googleapis/release-please).
It opens a release pull request after a releasable commit reaches `main`. Merging that pull request
updates `package.json`, `package-lock.json`, and the versioned entries in `CHANGELOG.md`, then creates
the GitHub Release.

Enable **Allow GitHub Actions to create and approve pull requests** in the repository's Actions
settings. Without it, the workflow cannot create the release pull request.

A release has two tags:

- An immutable, annotated `vMAJOR.MINOR.PATCH` tag, such as `v0.1.0`.
- A moving `vMAJOR` tag, such as `v0`, for consumers that deliberately follow compatible releases.

The installer and installed maintenance script resolve the newest stable `vMAJOR.MINOR.PATCH` tag.

## Create a release

1. Merge a [Conventional Commit](https://www.conventionalcommits.org/) to `main`. Use `fix:` for a
   patch release and `feat:` for a minor release. Before `1.0.0`, `!` or a `BREAKING CHANGE:`
   footer also produces a minor release; from `1.0.0` onward it produces a major release.
2. Release Please opens or updates its release pull request. Review its version changes and generated
   release notes.
3. Merge the release pull request. Release Please publishes the immutable version tag and GitHub
   Release, then the workflow updates the moving major tag.

For the first release, this repository is configured with the initial version `0.1.0`. Its first
release pull request will publish `v0.1.0` and set `v0` to that same commit.

## Set a specific version

Add a `Release-As` footer to a Conventional Commit when the normal commit type does not express the
desired version:

```text
chore: prepare a compatibility release

Release-As: 0.2.0
```

Release Please writes the version; do not manually change `package.json` or dispatch a release
workflow. No npm package or separate archive is published. GitHub supplies the source archives for
the release, and the committed `dist/index.js` is the executable action bundle.
