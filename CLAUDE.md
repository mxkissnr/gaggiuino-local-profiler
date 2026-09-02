# CLAUDE.md — Gaggiuino Local Profiler

Working rules for this repo. Follow these in every session.

## Language rules

- **Code, comments, commit messages, GitHub issues, PR descriptions** → always English
- **DOCS.md, README.md** → English (primary)
- **DOCS.de.md** → German (supplementary, always kept in sync with DOCS.md)
- **UI strings in index.html** → translated via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES/NL); add new keys to **all 6 language files** when adding UI text

## Workflow

> **STOP — issue first, then code. This rule has been violated repeatedly.**
> Do not write a single line of implementation before the issue exists.
> No exceptions for bug fixes, security fixes, refactors, or "small" changes.
> The only exception is a typo or single-word change.

**Step 1 — create the issue (always, before anything else):**
```
gh issue create --repo mxkissnr/gaggiuino-local-profiler --title "..." --label "bug|enhancement" --body "..."
gh project item-add 2 --owner mxkissnr --url <issue-url>
```

**Step 2 — implement the fix/feature.**

**Step 3 — close the issue in the commit message:** `Closes #N`

If you catch yourself writing code without an issue number in hand: stop, create the issue first, then continue.

## Branch workflow

**Work happens on `dev`, not `main`.** Feature/fix branches for a round are cut from
`origin/dev` and PR'd back into `dev` — `main` only receives merges from `dev` at release
time (see "Release & documentation rules" below). This applies to every PR unless the round
is itself the release round. When setting up a worktree, `glp-worktree` auto-detects this
(branches from `origin/dev` when it exists) — no manual `--base` needed for this repo.

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
speculated the version might become. Update all **three**:
- `gaggiuino-local-profiler/lib/constants.js` → `const GLP_VERSION  = '...'`
- `gaggiuino-local-profiler/config.yaml` → `version: "..."`
- `gaggiuino-local-profiler/package.json` → `"version": "..."` — easy to
  forget; `test/version-sync.test.js` fails if it's out of sync with the
  other two.

## Commits

Docs and code always in the same commit — never deliver CHANGELOG/DOCS/README separately afterward.

Every commit that ships a feature or fix needs:
1. Code change
2. `CHANGELOG.md` entry added under `## [Unreleased]` at the top — **keep it short: one bold lead-in sentence per bullet, optionally one short trailing clause, plus `Closes #N`.** No multi-sentence technical paragraphs, no file/function names, no "Review follow-up"/"Live-testing follow-up" sub-narratives, and no version number of its own — the entry stays under `## [Unreleased]` until the release step retitles that whole section. Home Assistant Supervisor renders this file verbatim in the add-on's own Update dialog (screenshot-verified 2026-08-11) — a long entry there is a real UX problem, not just a cosmetic one. The deep technical writeup (root cause, file paths, edge cases) belongs in the commit message and PR description, which stay the actual detailed record; don't duplicate it into `CHANGELOG.md`.
3. `DOCS.md` **and** `DOCS.de.md` update if the feature is user-facing — both languages always in sync
4. `README.md` features table update if it's a new feature

Do **not** bump `GLP_VERSION`/`config.yaml`/`package.json` or touch
`lib/whats-new.js` in a feature/fix commit — both happen once, together, at
release time (see Versioning above and the `glp-release-checklist` skill).

At release time:
```
git tag v<version>
git push origin main
git push origin v<version>
gh release create v<version> --title "v<version>" --notes "..."
```

## Release & documentation rules (since 2026-07-05)

- **A release ends at the GitHub release.** Do NOT deploy to Home Assistant — Max installs add-on/HACS updates himself. This is an internal workflow note for you, not something users need to know — **never** put a "no HA deploy included" / "install the update yourself" disclaimer in the public release notes body. Release notes are for end users and describe the software, not this project's internal release process.
- **GLP documentation lives ONLY in the GLP repos.** Never write GLP release notes into mkab-infra/CHANGELOG.md.
- **Update the GitHub wiki every feature round** (`git clone git@github.com:mxkissnr/gaggiuino-local-profiler.wiki.git`): pages are bilingual (`Page.md` + `Page-de.md`, always both). Minimum when touched by features: Coffee-Library, Analytics, Features, Home.
- **Keep README screenshots current** when the UI changes: `node scripts/screenshots.mjs` regenerates `docs/screenshots/*.png`.
- **Regenerate dev-stats at every release, not just when they look stale.** Run whatever the current dev-stats script is (see `scripts/`) and re-check DOCS.md/DOCS.de.md/README.md against the actual feature set shipped in that release — stale stats and stale feature docs are a recurring failure mode here.
- **Every commit involving Claude/an AI agent — including release/chore commits, not just feature commits — must carry a `Co-Authored-By:` trailer naming the SPECIFIC model, not a bare "Claude".** Format: `Co-Authored-By: Claude <model name> <noreply@anthropic.com>`, e.g. `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` or `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` — whichever model actually authored that commit. `DEVELOPMENT.md`'s model-breakdown table groups commits by this exact string, so a generic "Claude" silently pollutes the stats as an unidentifiable bucket. This has been silently skipped/genericized multiple times; every dispatch prompt (release agents included) must explicitly state which model string to use.

## Gaggiuino project boundaries

GLP is purely a client of the Gaggiuino machine's own WebSocket/REST API — never a firmware fork. No active firmware changes, no embedding/redistributing Gaggiuino's own code, JS bundles or other assets in the GLP repo (not even for research — throwaway downloads belong in the scratchpad, never in the repo). Gaggiuino's firmware is CC-BY-NC 4.0; GLP itself stays GPLv3 and non-commercial. Use "Gaggiuino" as a name/mark only descriptively ("for Gaggiuino machines"), never implying official affiliation. Goal: never get in the way of or harm the Gaggiuino developers — when in doubt, build more conservatively and ask Max rather than deciding unilaterally.

## Repo structure

```
gaggiuino-local-profiler/     ← HA app (main deliverable)
  server.js                   ← Node.js/Express backend
  routes/                     ← Express route handlers
  lib/                        ← Backend services, repositories, helpers
    machines/                 ← Machine registry (source of truth for machine config,
                                 see Key conventions below), per-type adapters
  public-src/                 ← Vite frontend source (views/, components/, i18n/, main.js)
  public/                     ← Vite build output (generated via `npm run build`, not edited directly)
  config.yaml                 ← HA app manifest + version
  CHANGELOG.md
  DOCS.md                     ← English docs
  DOCS.de.md                  ← German docs (extra)
README.md                     ← Repo root README (English)
```

## Key conventions

- **Machine config source of truth**: the `machines` SQLite table (`lib/machines/registry.js`)
  is the only source of truth for a machine's host and switch entity — never
  `options.json`. `options.json` (the HA add-on configuration) is a *tracked
  input*: `lib/machines/options-adoption.js` adopts a changed add-on option
  into the registry once, at startup; after that the registry's own value
  (including one intentionally cleared via Settings → Machines) always wins.
  Read machine config only through the facade —
  `registry.hostFor()`/`switchEntityFor()`/`baseUrlFor()`/`apiUrlFor()`
  (`machineId = null` means the default machine) — never
  `opts.machine_host`/`opts.switch_entity` directly; an ESLint
  `no-restricted-syntax` rule (`eslint.config.js`) enforces this outside the
  three files that legitimately read `options.json`
  (`lib/machines/registry.js`, `lib/data.js`, `lib/machines/options-adoption.js`).
  This exists because #638/#641/#643/#648 were four separate bugs from the
  same copy-pasted `opts`-shaped resolution logic — see the `## Unreleased`
  history in `CHANGELOG.md` for the full writeup.
- `shot.timestamp` is Unix seconds, `shot.duration / 10` = seconds
- `shot.profile?.name || shot.profileName` for profile name
- `shot.annotation?.coffee` etc. — annotation fields are optional
- `calcShotScore(shot, getShotData(shot))` returns null for test/empty shots
- All fetch calls use relative URLs (no leading `/`) for HA ingress compatibility
- Chart.js is loaded from CDN; reuse existing chart instances (destroy before re-creating)
- `/data/` is the persistent storage directory inside the app container
- i18n: translations live in `public-src/i18n/{de,en,it,fr,es,nl}.js` — each exports a default object; `constants.js` re-exports them as `TRANSLATIONS`; add new keys to **all 6 files**
- **PR AI disclosure** — every PR fills the PR template's "AI assistance disclosure" section
  (`none`/`assisted`/`substantial`/`generated` + tool/model); every AI-assisted commit carries
  a `Co-Authored-By:` trailer. CI enforces it. See CONTRIBUTING.md.

## GitHub project

Roadmap project ID: `2` (owner: mxkissnr), named **GLP Roadmap**.
Add all new feature/bug issues to it.
