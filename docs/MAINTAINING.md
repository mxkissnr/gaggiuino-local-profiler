# Maintaining the release-oriented branch model

This page is for maintainers. Contributors should read [CONTRIBUTING.md](../CONTRIBUTING.md).

## Branch model

- `main`: released versions only. It stays the default branch, because Home Assistant's app
  store reads the default branch.
- `dev`: holds exactly what the next release ships. Fixes and small features go to `dev` by PR,
  as before. Because `main` is the default branch, contributors must pick `dev` as the PR base
  by hand.
- `feature/<name>`: a large change that may ship in a later release, for example the
  profile-relative score (#1505). All PRs for it target the feature branch. It reaches `dev` in
  one PR, only when it is ready for the next release. Keep it current by merging `dev` into it at
  least once a week and after every release. Merge, do not rebase, because several people may
  share the branch.

| Branch | Holds | Open PRs against it? |
|---|---|---|
| `main` | released versions only | No — only the release PR from `release/vX.Y.0` |
| `dev` | exactly what the next release ships | Yes — fixes and small features go here |
| `feature/*` | a large change that may ship in a later release | Yes — when the issue belongs to that feature |
| `release/*` | a release in acceptance, or a patch line | No — maintainers cut and merge these |

## Starting a feature branch

1. Create it from `dev`: `git switch dev && git pull && git switch -c feature/<name>`.
2. Add it to the issue or epic, so contributors know where to send PRs.
3. Merge `dev` into it at least once a week and after every release. Merge, not rebase.
4. Finish it with one PR to `dev`, then remove it from `DEV_FEATURES`.

## Dev channel

The dev build is `dev` plus the feature branches listed in the repository variable
`DEV_FEATURES`, merged in the build runner
([`.github/workflows/build-dev.yaml`](../.github/workflows/build-dev.yaml)). The listed names
appear in the dev version string.

Add or drop a feature and rebuild:

```sh
gh variable set DEV_FEATURES --body "feature/a feature/b" && gh workflow run build-dev.yaml --ref dev
```

A push to a listed feature branch does not rebuild the channel on its own: the workflow and the
secrets it uses only ever run from `dev`'s own copy, never from an unreviewed branch. Run
`gh workflow run build-dev.yaml --ref dev` after pushing.

A conflict fails the dev build and names the branch. The fix is to merge `dev` into that feature
branch; the next build picks up the merge.

## Release

1. Cut `release/vX.Y.0` from `dev`.
2. Run the acceptance pass on it and record it under
   [`docs/acceptance/`](../gaggiuino-local-profiler/docs/acceptance/).
3. Minor releases only: run `npm run coverage:ratchet` on the release branch and commit the raised
   thresholds in `vitest.config.ts`. Go coverage is shown in the CI job summary.
4. Merge the release PR to `main` with `--merge`, not squash.
5. Merge `main` back into `dev` afterwards.

`npm run release:check` (from `gaggiuino-local-profiler/`) verifies the version, changelog and
acceptance files.

Cadence: a minor release about every two weeks, patch releases when needed.

## Patch release

`release/X.Y.x` is cut from the `vX.Y.0` tag. A fix is merged to `dev` first. If a released
version also needs it, the fix gets the label `backport-X.Y` and is cherry-picked into
`release/X.Y.x` by PR. Never merge `dev` downward.

```sh
git switch release/X.Y.x
git cherry-pick -x <sha>
# push to a branch and open a PR to release/X.Y.x
# tag vX.Y.Z after the PR is merged
git tag vX.Y.Z
```

## Contributions

- Merge good external PRs as they are and do follow-up changes in a separate PR. Do not
  re-implement them.
- Close issues from users only with a comment that says what happened (the fix and the version)
  or why not.
