# Contributing

Bug reports, feature ideas and pull requests are welcome!

## Workflow

1. **Open an issue first** — describe the bug or feature before writing any code  
   (no PRs without a linked issue — see [CLAUDE.md](CLAUDE.md) for context)
2. **Fork & branch** — `feature/short-description` or `fix/short-description`
3. **Implement** — commit with `Closes #N` in the message
4. **Pull request** — see [Pull requests](#pull-requests) below

## Pull requests

Every PR must:

- **Link an issue** — `Closes #N` in the description (no PRs without a linked issue)
- **Do one thing** — keep the diff focused; split unrelated changes
- **Use a Conventional Commits title in English** — `feat:` `fix:` `docs:` `chore:` `refactor:` `test:` `build:`
- **Explain what and why** in the description, not just what
- **Pass CI** — lint, tests and build green before requesting review
- **Update `CHANGELOG.md`** for any user-facing change
- **Include before/after screenshots** for UI changes
- **Disclose AI assistance** — see below
- **No real names** in commit messages, PR text, code comments or docs

### AI assistance

Be transparent about AI tool use so reviewers know what they are reviewing.

- **Per commit (machine-readable, required):** every commit an AI tool helped write carries a
  trailer, e.g. `Co-Authored-By: Claude <noreply@anthropic.com>` or
  `Co-Authored-By: Copilot <198982749+Copilot@users.noreply.github.com>`. Claude Code also
  adds a `Claude-Session:` trailer. For this repo the Claude trailer names the specific model,
  e.g. `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (see [CLAUDE.md](CLAUDE.md)).
- **Per PR (summary, required):** the "AI assistance disclosure" section of the PR template —
  one of `none` / `assisted` / `substantial` / `generated`, plus the tool and model names.

CI blocks the PR until the disclosure section is filled in, and fails on a contradiction
(commits carry an AI trailer while the PR claims `none`).

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
| Storage | SQLite (`lib/db.js`, better-sqlite3) at `/data/glp.db` for shot data **and** machine config (the `machines` table is the source of truth — see [CLAUDE.md](CLAUDE.md#key-conventions)); `/data/*.json` for token, preheat state, profile cache, and `options.json` (a tracked *input* to the machine registry, adopted on start — not live config, see `lib/machines/options-adoption.js`) |
| Translations | UI strings via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES/NL) — add all 6 languages for new keys |
| URLs | Always relative (no leading `/`) for HA ingress compatibility |

## Versioning

`MAJOR.MINOR.PATCH` — patch for fixes, minor for new features. Both `gaggiuino-local-profiler/lib/constants.js` (`GLP_VERSION`) and `gaggiuino-local-profiler/config.yaml` must be updated together.
