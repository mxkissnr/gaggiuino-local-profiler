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
| Backend | Go — `gaggiuino-local-profiler/go/` (`cmd/server` entrypoint, one `internal/<domain>` package per concern; see `go/README.md`) |
| Frontend | SPA source is `gaggiuino-local-profiler/public-src/` (views/, components/, i18n/, main.js, shared/); the production bundle is built from Go into `go/internal/webapp/dist/`, which the server embeds via `//go:embed`. See [Frontend build](#frontend-build) — `npm`/Vite is the local dev server only |
| Routes | Each `internal/<domain>` package registers its own HTTP routes (`RegisterRoutes`), wired together in `go/cmd/server/main.go` |
| Storage | SQLite (`go/internal/db`, `modernc.org/sqlite` — pure Go, no CGo) at `/data/glp.db` for shot data **and** machine config (the `machines` table is the source of truth — see [CLAUDE.md](CLAUDE.md#key-conventions)); `/data/*.json` for token, preheat state, profile cache, and `options.json` (a tracked *input* to the machine registry, adopted on start — not live config, see `go/internal/machines`) |
| Translations | UI strings via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES/NL) — add all 6 languages for new keys |
| URLs | Always relative (no leading `/`) for HA ingress compatibility |

## Frontend build

The SPA is built two different ways, for two different purposes — they no longer share a tool:

| Purpose | Command | Tool |
|---|---|---|
| Production bundle (Docker image + CI, embedded via `//go:embed`) | `make -C go frontend`, or `go run ./cmd/frontend-build` from `go/` | esbuild's Go API (`go/cmd/frontend-build`) — no Node involved |
| Local dev server with HMR | `npm run dev` | Vite |

`go/cmd/frontend-build` reads `public-src/index.html`, bundles `public-src/` into `go/internal/webapp/dist/`
(with hashed filenames and relative `./assets/...` URLs, both load-bearing for HA ingress — see #797),
and rewrites the module `<script>` tag the way Vite's HTML plugin used to. The Dockerfile's builder
stage and `scripts/e2e-harness.mjs` both call it, so the shipped image and the E2E server embed the
same bundle.

Node is therefore a **local-dev-only** dependency: it is not in the image and not in CI's build gate
(`npm ci` there is only for lint/vitest/Playwright). `npm run build` still exists if you want to diff
Vite's bundle against the Go builder's, but nothing shipped uses it.

Note that `make -C go frontend` overwrites the committed `go/internal/webapp/dist/index.html`
placeholder, so `git status` will show the dist tree as modified afterwards — `git checkout --
gaggiuino-local-profiler/go/internal/webapp/dist` puts it back (the e2e harness restores it itself).

## Versioning

`MAJOR.MINOR.PATCH` — patch for fixes, minor for new features. `gaggiuino-local-profiler/config.yaml`'s `version:` is canonical; three more spots must be bumped to match it in the same commit: `package.json`, `go/internal/system/version.go` (`glpVersion`) and `go/internal/backup/bundle.go` (`glpVersion`). `test/version-sync.test.js` and `scripts/release-check.mjs` enforce the match.
