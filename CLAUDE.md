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

## Repo structure

```
gaggiuino-local-profiler/     ← HA app (main deliverable)
  server.js                   ← Node.js/Express backend
  public/index.html           ← Single-file frontend (all CSS + JS inline)
  config.yaml                 ← HA app manifest + version
  CHANGELOG.md
  DOCS.md                     ← English docs
  DOCS.de.md                  ← German docs (extra)
gaggiuino-local-profiler-dev/ ← Dev app (pulls from main branch on start)
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
