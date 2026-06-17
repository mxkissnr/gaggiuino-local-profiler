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
| Frontend | Single-file HTML + inline CSS/JS — `gaggiuino-local-profiler/public/index.html` (no build step) |
| Routes | `gaggiuino-local-profiler/routes/` — one file per concern |
| Storage | `/data/*.json` inside the app container |
| Translations | UI strings via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES) — add all 5 languages for new keys |
| URLs | Always relative (no leading `/`) for HA ingress compatibility |

## Versioning

`MAJOR.MINOR.PATCH` — patch for fixes, minor for new features. Both `server.js` and `config.yaml` must be updated together.
