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

## Versioning

- Patch fix → bump third number: `1.20.0 → 1.20.1`
- New feature → bump second number: `1.20.1 → 1.21.0`
- Breaking change → bump first number (rare)

Always update **both**:
- `gaggiuino-local-profiler/lib/constants.js` → `const GLP_VERSION  = '...'`
- `gaggiuino-local-profiler/config.yaml` → `version: "..."`

## Commits

Docs and code always in the same commit — never deliver CHANGELOG/DOCS/README separately afterward.

Every commit that ships a feature or fix needs:
1. Code change
2. `CHANGELOG.md` entry at the top
3. `DOCS.md` **and** `DOCS.de.md` update if the feature is user-facing — both languages always in sync
4. `README.md` features table update if it's a new feature

After the commit:
```
git tag v<version>
git push origin main
git push origin v<version>
gh release create v<version> --title "v<version>" --notes "..."
```

## Release & documentation rules (since 2026-07-05)

- **A release ends at the GitHub release.** Do NOT deploy to Home Assistant — Max installs add-on/HACS updates himself.
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
  public-src/                 ← Vite frontend source (views/, components/, i18n/, main.js)
  public/                     ← Vite build output (generated via `npm run build`, not edited directly)
  config.yaml                 ← HA app manifest + version
  CHANGELOG.md
  DOCS.md                     ← English docs
  DOCS.de.md                  ← German docs (extra)
README.md                     ← Repo root README (English)
```

## Key conventions

- `shot.timestamp` is Unix seconds, `shot.duration / 10` = seconds
- `shot.profile?.name || shot.profileName` for profile name
- `shot.annotation?.coffee` etc. — annotation fields are optional
- `calcShotScore(shot, getShotData(shot))` returns null for test/empty shots
- All fetch calls use relative URLs (no leading `/`) for HA ingress compatibility
- Chart.js is loaded from CDN; reuse existing chart instances (destroy before re-creating)
- `/data/` is the persistent storage directory inside the app container
- i18n: translations live in `public-src/i18n/{de,en,it,fr,es,nl}.js` — each exports a default object; `constants.js` re-exports them as `TRANSLATIONS`; add new keys to **all 6 files**

## GitHub project

Roadmap project ID: `2` (owner: mxkissnr), named **GLP Roadmap**.
Add all new feature/bug issues to it.
