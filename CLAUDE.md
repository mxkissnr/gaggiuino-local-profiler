# CLAUDE.md — Gaggiuino Local Profiler

Working rules for this repo. Follow these in every session.

## Language rules

- **Code, comments, commit messages, GitHub issues, PR descriptions** → always English
- **DOCS.md, README.md** → English (primary)
- **DOCS.de.md** → German (supplementary, always kept in sync with DOCS.md)
- **UI strings in index.html** → translated via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES); add new keys to all 5 languages when adding UI text

## Workflow

**Issue first, then code.**
Every bug fix or feature needs a GitHub issue before the first line of code.
Only exception: typo fixes or single-word changes.

```
gh issue create --repo mxkissnr/gaggiuino-local-profiler --title "..." --label "bug|enhancement" --body "..."
gh project item-add 2 --owner mxkissnr --url <issue-url>
```

Close the issue in the commit message: `Closes #N`

## Versioning

- Patch fix → bump third number: `1.20.0 → 1.20.1`
- New feature → bump second number: `1.20.1 → 1.21.0`
- Breaking change → bump first number (rare)

Always update **both**:
- `gaggiuino-local-profiler/server.js` → `const GLP_VERSION = '...'`
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

## Repo structure

```
gaggiuino-local-profiler/     ← HA add-on (main deliverable)
  server.js                   ← Node.js/Express backend
  public/index.html           ← Single-file frontend (all CSS + JS inline)
  config.yaml                 ← HA add-on manifest + version
  CHANGELOG.md
  DOCS.md                     ← English docs
  DOCS.de.md                  ← German docs (extra)
gaggiuino-local-profiler-dev/ ← Dev add-on (pulls from main branch on start)
README.md                     ← Repo root README (English)
```

## Key conventions

- `shot.timestamp` is Unix seconds, `shot.duration / 10` = seconds
- `shot.profile?.name || shot.profileName` for profile name
- `shot.annotation?.coffee` etc. — annotation fields are optional
- `calcShotScore(shot, getShotData(shot))` returns null for test/empty shots
- All fetch calls use relative URLs (no leading `/`) for HA ingress compatibility
- Chart.js is loaded from CDN; reuse existing chart instances (destroy before re-creating)
- `/data/` is the persistent storage directory inside the add-on container

## GitHub project

Roadmap project ID: `2` (owner: mxkissnr), named **GLP Roadmap**.
Add all new feature/bug issues to it.
