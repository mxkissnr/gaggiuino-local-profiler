# Contributing

Bug reports, feature ideas and pull requests are welcome!

## Workflow

1. **Open an issue first** — describe the bug or feature before writing any code  
   (no PRs without a linked issue — see [CLAUDE.md](CLAUDE.md) for context)
2. **Fork & branch** — `feature/short-description` or `fix/short-description`
3. **Implement** — commit with `Closes #N` in the message
4. **Pull request** — reference the issue; keep PRs focused on one thing

## Reporting a bug

Include:
- App version (visible in the HA app info page)
- Expected vs. actual behaviour
- Relevant Home Assistant log output (`Settings → System → Logs`)

## Code notes

| Area | Details |
|---|---|
| Backend | Node.js / Express — `gaggiuino-local-profiler/server.js` |
| Frontend | Vite build from `gaggiuino-local-profiler/public-src/` (views/, components/, i18n/, main.js) — `public/` is generated build output, not edited directly |
| Routes | `gaggiuino-local-profiler/routes/` — one file per concern |
| Storage | SQLite (`lib/db.js`, better-sqlite3) at `/data/glp.db` for shot data; `/data/*.json` only for token, options, preheat state and profile cache |
| Translations | UI strings via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES/NL) — add all 6 languages for new keys |
| URLs | Always relative (no leading `/`) for HA ingress compatibility |

## Versioning

`MAJOR.MINOR.PATCH` — patch for fixes, minor for new features. Both `gaggiuino-local-profiler/lib/constants.js` (`GLP_VERSION`) and `gaggiuino-local-profiler/config.yaml` must be updated together.
