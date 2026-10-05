# Changelog fragments

One file per PR, so two open PRs never edit the same spot in `CHANGELOG.md`
and never conflict on merge.

Name: `<issue>.<section>.md`, or `<issue>-<suffix>.<section>.md` when one issue
has several fragments. `<section>` is one of `added`, `changed`, `deprecated`,
`removed`, `fixed`, `security` (lowercase, matching the CHANGELOG heading).
Examples: `1421.fixed.md`, `1421-2.added.md`.

Content: one or more bullet lines exactly as they should appear in
`CHANGELOG.md`, for example:

    - **One bold sentence.** Closes #1421

Blank lines are ignored; a fragment with no `- ` bullet line is rejected.
The release run collects the fragments with `npm run changelog:collect`, which
folds them into `## [Unreleased]` and deletes the collected files. This
README is never collected.
