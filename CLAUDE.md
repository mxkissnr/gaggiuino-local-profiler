# CLAUDE.md — Gaggiuino Local Profiler

Working rules for this repo. Follow these in every session. The checklist every contribution has to meet, whoever or whatever writes it, is in AGENTS.md and imported here:

@AGENTS.md

Everything below is maintainer- or Claude-specific and comes on top of it.

## Workflow

> **STOP — issue first, then code (AGENTS.md). In Claude sessions this rule has been violated repeatedly.**
> Do not write a single line of implementation before the issue exists.
> No exceptions for bug fixes, security fixes, refactors, or "small" changes.
> The only exception is a typo or single-word change.

**Step 1 — create the issue (always, before anything else):**
```
gh issue create --repo mxkissnr/gaggiuino-local-profiler --title "..." --label "bug|enhancement" --body "..."
```
The GLP Roadmap project adds new issues from this repo automatically; there is no manual `gh project item-add` step.

**Step 2 — implement the fix/feature.**

**Step 3 — link the issue in the PR body with `Closes #N`.** GitHub's own auto-close only fires on a merge into `main`. On a merge into `dev`, the close-dev-issues workflow reads the PR body: it closes issues opened by the repository owner, a bot or the project's automation account, and leaves issues from external reporters open with the `fixed-in-dev` label and a comment until the release ships the fix.

If you catch yourself writing code without an issue number in hand: stop, create the issue first, then continue.

## Branch workflow

Work happens on `dev`, not `main` (AGENTS.md). Feature/fix branches for a round are cut from
`origin/dev` and PR'd back into `dev` — `main` only receives merges from `dev` at release
time (see "Release & documentation rules" below). This applies to every PR unless the round
is itself the release round. When setting up a worktree, `glp-worktree` auto-detects this
(branches from `origin/dev` when it exists) — no manual `--base` needed for this repo.

**Patch line** (maintainers only, details in [docs/MAINTAINING.md](docs/MAINTAINING.md#patch-release)):
`release/X.Y.x` is cut from the `vX.Y.0` tag. A fix is merged to `dev` first; if a released
version also needs it, it gets the label `backport-X.Y` and is cherry-picked with
`git cherry-pick -x <sha>` into `release/X.Y.x` by PR. Tag `vX.Y.Z` after that PR is merged.
Never merge `dev` downward.

## Regression policy

> **A feature or fix must never break already-working functionality.** This
> is a hard constraint, not a trade-off against shipping speed.

Concretely:
- Before "fixing" something that looks wrong, verify against real ground
  truth (an actual shot/profile/data export from Max, existing passing
  tests, or the machine's own documented protocol) — not just plausible
  general theory. A plausible-sounding fix that isn't checked against real
  data can silently introduce a regression that looks like an improvement.
  (Precedent: #323's "fix" to the bean-to-profile suggestion's Decline Flow
  phase direction was based on general extraction-theory reasoning and
  reverted real behavior that matched Max's own live-verified profiles —
  caught only when Max supplied the actual profile JSON for comparison.)
- When changing a function that's called from multiple places (e.g. a
  shared repository/data-layer helper), check every call site's assumptions
  before changing the function's contract — don't assume the call site you
  're looking at is the only one. (Precedent: #327 — `saveOrders()` silently
  deleted any DB row not present in its argument array; every caller passed
  it an already-filtered subset, so the function's real behavior was "wipe
  the whole table" even though no single call site looked destructive in
  isolation.)
- If a fix could plausibly have been silently losing/corrupting data before
  the fix (not just showing a wrong value), say so explicitly and check for
  a recovery path (e.g. `/api/backup` exports) — don't just fix and move on
  as if it were a display bug.
- Run the full existing test suite after every change, not just tests
  related to the change, and treat any newly-failing test as a stop
  condition, not noise to explain away.
- (Precedent: #638/#641/#643/#648 — machine host/switch entity resolution
  was copy-pasted into five files instead of living in one place, and each
  copy accumulated its own version of the same bug; a user-reported bug
  shipped in v2.29.0 anyway because no test proved a *setting change* changed
  behavior, only that saving succeeded.) Two rules that follow from it:
  (a) If a setting is editable in the UI, a test must prove that *changing*
  it changes behavior — a test that only checks the save/round-trip is not
  enough.
  (b) If the same resolution logic is needed in more than two places, it
  belongs in one shared helper — copied logic multiplies its own bugs (#643:
  five copies of the same three-line function).
- **This app supports multiple concurrent machines.** Any new state that
  tracks an in-progress, per-operation value — sync/import progress, live
  counters, displayed totals, timers, "which machine is this about" — must
  be keyed by `machineId`, never a shared scalar/global that the
  last-writing machine overwrites. Design it explicitly for N concurrent
  machines from the start, don't default to a single-machine mental model
  and fix it after review. (Precedent: this exact bug class shipped three
  times before being caught — #730/#732's sync-progress toast tracked one
  scalar "last progress" instead of a per-machine map, and #742/#743's
  live shot-counter display had the same issue with two machines
  backfilling concurrently.)

## Versioning

**The version number only ever changes at release time, on `main`.** Dev/
feature commits never touch it — see #890: bumping per dev commit made
`main`'s version jump by however many increments had piled up on `dev`
since the last release (e.g. 2.34.0 → 2.37.1 in one step), which is
confusing in the CHANGELOG/GitHub releases list and doesn't reflect actual
release cadence (no one ever installed the intermediate versions).

- Patch fix → bump third number: `1.20.0 → 1.20.1`
- New feature → bump second number: `1.20.1 → 1.21.0`
- Breaking change → bump first number (rare)

**Disambiguation (no size carve-out):** any net-new user-facing capability —
however small (e.g. "click a photo to enlarge it") — is a feature and gets a
minor bump. A release stays patch only if every `## [Unreleased]` entry
since the last release is a pure bugfix/regression-restore with zero new
capability, no matter how many commits it took.

At release time (see `glp-release-checklist` skill), bump exactly **one**
step from `main`'s currently-released version — never further, and never
skip ahead to whatever a dev commit's own CHANGELOG-drafting incorrectly
speculated the version might become. `config.yaml`'s `version:` is
canonical (HA Supervisor reads it directly); update all **four** spots
together, in one commit:
- `gaggiuino-local-profiler/config.yaml` → `version: "..."`
- `gaggiuino-local-profiler/package.json` → `"version": "..."`
- `gaggiuino-local-profiler/go/internal/system/version.go` → `const glpVersion = "..."`
- `gaggiuino-local-profiler/go/internal/backup/bundle.go` → `const glpVersion = "..."`

`test/version-sync.test.ts` fails if any of the latter three drift from
`config.yaml`; `scripts/release-check.mts` check 1 does the same.
(The geocoder's User-Agent is derived from `system.Version()` — nothing to bump there.)

## Commits

The changelog fragment, docs, version and whats-new rules are in AGENTS.md. On top of them:

- Docs and code always go in the same commit — never deliver CHANGELOG/DOCS/README separately afterward.
- Keep fragments short (one bold lead-in sentence per bullet, optionally one short trailing clause, no "Review follow-up"/"Live-testing follow-up" sub-narratives): Home Assistant Supervisor renders these entries verbatim in the app's own Update dialog (screenshot-verified 2026-08-11), so a long entry there is a real UX problem. The deep technical writeup (root cause, file paths, edge cases) belongs in the commit message and PR description, which stay the actual detailed record. The release run runs `npm run changelog:collect` to fold the fragments into `## [Unreleased]` before it retitles that section.
- The version bump and the whats-new update happen once, together, at release time (see Versioning above and the `glp-release-checklist` skill).
- Tagging and the GitHub release are part of the release run only (`releaser` agent / `glp-release-checklist` skill), never done by hand from a feature round.

## Release & documentation rules (since 2026-07-05)

- **A release ends at the GitHub release.** Do NOT deploy to Home Assistant — Max installs app/HACS updates himself. This is an internal workflow note for you, not something users need to know — **never** put a "no HA deploy included" / "install the update yourself" disclaimer in the public release notes body. Release notes are for end users and describe the software, not this project's internal release process.
- **GLP documentation lives ONLY in the GLP repos.** Never write GLP release notes into mkab-infra/CHANGELOG.md.
- **Update the GitHub wiki every feature round** (`git clone git@github.com:mxkissnr/gaggiuino-local-profiler.wiki.git`): pages are bilingual (`Page.md` + `Page-de.md`, always both). Minimum when touched by features: Coffee-Library, Analytics, Features, Home.
- **README screenshots are regenerated in the release run only**, with the screenshot script described in CONTRIBUTING.md ("Screenshots"); `npm run release:check` check 3 gates their freshness. Feature and fix PRs never touch `docs/screenshots/` (AGENTS.md); a UI PR shows before/after images in its description instead.
- **Regenerate dev-stats at every release, not just when they look stale.** Run whatever the current dev-stats script is (see `scripts/`) and re-check DOCS.md/DOCS.de.md/README.md against the actual feature set shipped in that release — stale stats and stale feature docs are a recurring failure mode here.
- **Claude's `Co-Authored-By:` trailer names the specific model** (the trailer rule itself is in AGENTS.md), on release/chore commits too: `Co-Authored-By: Claude <model name> <noreply@anthropic.com>`, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` or `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, whichever model actually authored that commit. `DEVELOPMENT.md`'s model-breakdown table groups commits by this exact string, so a generic "Claude" silently pollutes the stats. This has been skipped or genericized multiple times; every dispatch prompt (release agents included) must state which model string to use.

- **Easter eggs (hidden panels, secret gestures, secret badges) are never mentioned in CHANGELOG.md, whats-new, DOCS/README, release notes or PR titles that end up in release notes — finding them is the point.**

## Gaggiuino project boundaries

The boundary rule is in AGENTS.md. On top of it: throwaway downloads for research belong in the scratchpad, never in the repo, and "Gaggiuino" is never used in a way that implies official affiliation. Goal: never get in the way of or harm the Gaggiuino developers — when in doubt, build more conservatively and ask the maintainer rather than deciding unilaterally.

## Repo structure

```
gaggiuino-local-profiler/     ← HA app (main deliverable)
  go/                         ← Go backend (see go/README.md)
    cmd/server/               ← main() — wires every internal/* domain together
    internal/<domain>/        ← one package per concern (shots, library, machines,
                                 orders, backup, db, auth, sse, system, …); each
                                 registers its own HTTP routes
    internal/machines/        ← machine registry (source of truth for machine
                                 config, see Key conventions below) + per-type adapters
    internal/webapp/          ← embeds public/ and serves the SPA at /
  public-src/                 ← Vite frontend source, TypeScript (views/, components/, i18n/, shared/, main.ts)
  public/                     ← Vite build output (generated via `npm run build`, not edited directly)
  config.yaml                 ← HA app manifest + canonical version
  Dockerfile                  ← multi-arch image: Vite build → Go cross-compile → Alpine runtime
  CHANGELOG.md
  DOCS.md                     ← English docs
  DOCS.de.md                  ← German docs (extra)
README.md                     ← Repo root README (English)
```

## Key conventions

- **Machine config source of truth**: the `machines` SQLite table
  (`go/internal/machines`, the registry) is the only source of truth for a
  machine's host and switch entity — never `options.json`. `options.json`
  (the HA app configuration) carries no machine options (#662): on an empty
  registry the default machine is seeded unconfigured (empty host, #718)
  and is then set up via Settings → Machines only. Read machine config only through the registry's resolver methods
  (`machineId = nil`/`0` means the default machine) — never off a raw
  options bag. This exists because #638/#641/#643/#648 were four separate
  bugs from the same copy-pasted `opts`-shaped resolution logic (the Node
  backend backed the invariant with an ESLint `no-restricted-syntax` rule;
  Go's typed `Machine.Host` field plus review is the substitute, see
  `go/internal/machines/doc.go`) — full writeup in `CHANGELOG.md`.
- `shot.timestamp` is Unix seconds, `shot.duration / 10` = seconds
- `shot.profile?.name || shot.profileName` for profile name
- `shot.annotation?.coffee` etc. — annotation fields are optional
- `calcShotScore(shot, getShotData(shot))` returns null for test/empty shots
- Chart.js is an npm dependency bundled by Vite; reuse existing chart instances (destroy before re-creating)
- `/data/` is the persistent storage directory inside the app container
- i18n: each language file in `public-src/i18n/` exports a default object; `constants.ts` re-exports them as `TRANSLATIONS` (the six-languages rule is in AGENTS.md)
- **Go + TypeScript only** (rule in AGENTS.md): vendored `/vendor/` files are the only exception to the no-JavaScript rule. Tooling Node runs directly is `.mts` and runs on Node's built-in type stripping (official Node ≥ 22.18; CI uses 26); `npm run lint` passes ESLint's `unstable_native_nodejs_ts_config` flag. Service workers are `.ts`, bundled to classic scripts and typed by `tsconfig.sw.json`. The SPA under `public-src/` is `.ts`; `tsconfig.json` turns on `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

## GitHub project

Roadmap project ID: `2` (owner: mxkissnr), named **GLP Roadmap**.
New issues from this repo are added to it automatically.
