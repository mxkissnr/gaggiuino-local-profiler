# Contributing

Bug reports, feature ideas and pull requests are welcome!

The [roadmap board](https://github.com/users/mxkissnr/projects/2/views/2) shows what is planned for the next release, what comes later and
where help is wanted.

## Workflow

1. **Open an issue first** — describe the bug or feature before writing any code
   (no PRs without a linked issue)
2. **Fork & branch** — `fix/…` or `feat/…`
3. **Target the right branch** — open the PR against `dev`, or against the feature branch named
   in the issue when the issue belongs to a feature, such as the score epic. See
   [Which branch?](#which-branch) below
4. **Implement with tests**
5. **Open the pull request** — see [Pull requests](#pull-requests) below

See [docs/MAINTAINING.md](docs/MAINTAINING.md) for release and branch maintenance.

### Which branch?

`main` stays the default branch because Home Assistant's app store reads the default branch, so
contributors pick `dev` as the PR base by hand.

| Branch | Holds | Open PRs against it? |
|---|---|---|
| `main` | released versions only | No — only the release PR from `release/vX.Y.0` |
| `dev` | exactly what the next release ships | Yes — fixes and small features go here |
| `feature/*` | a large change that may ship in a later release | Yes — when the issue belongs to that feature |
| `release/*` | a release in acceptance, or a patch line | No — maintainers cut and merge these |

## Pull requests

Every PR must:

- **Link an issue** — `Closes #N` in the description (no PRs without a linked issue)
- **Do one thing** — keep the diff focused; split unrelated changes
- **Use a Conventional Commits title in English** — `feat:` `fix:` `docs:` `chore:` `refactor:` `test:` `build:`
- **Explain what and why** in the description, not just what
- **Pass CI** — lint, tests and build green before requesting review
- **Add a changelog fragment** in `gaggiuino-local-profiler/changelog.d/<issue>.<added|changed|fixed|removed|security>.md` for user-visible changes. One bold sentence ending with `Closes #N`. Never edit `CHANGELOG.md` directly.
- **Include before/after screenshots** for UI changes
- **Disclose AI assistance** — see below
- **No real names** in commit messages, PR text, code comments or docs

### AI assistance

Be transparent about AI tool use so reviewers know what they are reviewing.

- **Per commit (machine-readable, required):** every commit an AI tool helped write carries a
  trailer, e.g. `Co-Authored-By: Claude <noreply@anthropic.com>` or
  `Co-Authored-By: Copilot <198982749+Copilot@users.noreply.github.com>`. For this repo the
  Claude trailer names the specific model, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
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
| Frontend | SPA source is `gaggiuino-local-profiler/public-src/` (views/, components/, i18n/, main.ts, shared/); the production bundle is built from Go into `go/internal/webapp/dist/`, which the server embeds via `//go:embed`. See [Frontend build](#frontend-build) — `npm`/Vite is the local dev server only |
| Routes | Each `internal/<domain>` package registers its own HTTP routes (`RegisterRoutes`), wired together in `go/cmd/server/main.go` |
| Storage | SQLite (`go/internal/db`, `modernc.org/sqlite` — pure Go, no CGo) at `/data/glp.db` for shot data **and** machine config (the `machines` table is the source of truth — see [CLAUDE.md](CLAUDE.md#key-conventions)); `/data/*.json` for token, preheat state, profile cache, and `options.json` (a tracked *input* to the machine registry, adopted on start — not live config, see `go/internal/machines`) |
| Translations | UI strings via `t()` + `TRANSLATIONS` object (DE/EN/IT/FR/ES/NL) — add all 6 languages for new keys |
| URLs | Always relative (no leading `/`) for HA ingress compatibility |

## Large files

`gaggiuino-local-profiler/public-src/views/analytics.ts`,
`gaggiuino-local-profiler/public-src/main.ts` and
`gaggiuino-local-profiler/go/internal/system/poll.go` are oversized. When a PR changes one of
them substantially, move the part it touches into its own module in the same PR. Do not open PRs
that only reorganize these files.

## Frontend build

The SPA is built two different ways, for two different purposes — they no longer share a tool:

| Purpose | Command | Tool |
|---|---|---|
| Production bundle (Docker image + CI, embedded via `//go:embed`) | `make -C go frontend`, or `go run ./cmd/frontend-build` from `go/` | esbuild's Go API (`go/cmd/frontend-build`) — no Node involved |
| Local dev server with HMR | `npm run dev` | Vite |

`go/cmd/frontend-build` reads `public-src/index.html`, bundles `public-src/` into `go/internal/webapp/dist/`
(with hashed filenames and relative `./assets/...` URLs, both load-bearing for HA ingress — see #797),
and rewrites the module `<script>` tag the way Vite's HTML plugin used to. The Dockerfile's builder
stage and `scripts/e2e-harness.mts` both call it, so the shipped image and the E2E server embed the
same bundle.

Node is therefore a **local-dev-only** dependency: it is not in the image and not in CI's build gate
(`npm ci` there is only for lint/vitest/Playwright). `npm run build` still exists if you want to diff
Vite's bundle against the Go builder's, but nothing shipped uses it.

Note that `make -C go frontend` overwrites the committed `go/internal/webapp/dist/index.html`
placeholder, so `git status` will show the dist tree as modified afterwards — `git checkout --
gaggiuino-local-profiler/go/internal/webapp/dist` puts it back (the e2e harness restores it itself).

### HA-ingress gate for a frontend change

`go/cmd/server/smoke_test.go`'s `TestIngressSmoke_*` set is the gate #797 established and #1033
re-uses (no leading-slash `href`/`src`/`action`/`hx-*`, relative `Location`, PWA gating, SSE
unbuffered, ingress auth). It resolves `//go:embed all:dist` at **compile time**, so it only
exercises the bundle that happens to be in `dist/` — run it with the real one in place, not against
the 810-byte placeholder that a bare `go test ./...` sees:

```sh
make -C go frontend
(cd go && go test ./cmd/server/ -run TestIngressSmoke -v)
git checkout -- gaggiuino-local-profiler/go/internal/webapp/dist
```

`scripts/e2e-harness.mts` does both halves on its own (builds the bundle, boots the real server,
restores the placeholder), which is why the E2E job asserts against the real bundle.

## Screenshots

`gaggiuino-local-profiler/scripts/screenshots.mts` regenerates `docs/screenshots/*.png` for the
README and wiki from the built-in demo seed; run it from `gaggiuino-local-profiler/`:

```sh
node scripts/screenshots.mts [path/to/wiki-repo]
```

It needs `npx playwright install chromium` once beforehand. With the optional wiki-repo argument
it also copies the PNGs into that repo's `images/`.

To build the screenshots from real data instead of the synthetic seed, point the script at a GLP
backup zip (created via Settings → Backup in the app):

```sh
GLP_SCREENSHOT_BACKUP=/path/to/backup.zip node scripts/screenshots.mts
```

The zip is restored into the throwaway instance through the app's own `POST /api/restore`; a
restore that fails aborts the run. `gaggiuino-local-profiler/scripts/*.zip` is git-ignored, so keep
the backup there or outside the repo — never commit it. Review the resulting PNGs for personal
data before committing them.

In backup mode every screenshot except `live.png` and `orders.png` comes from the restored backup:
`shots.png`, `library.png`, `flavor-wheel.png`, `analytics.png`, `analytics-machines.png`,
`maintenance.png`, `dialin.png` and `settings.png`. `live.png` and `orders.png` always come from the
seeded demo instance — a real backup is normally all completed orders against a machine the
throwaway instance cannot reach, so those two views would render empty, and backup mode leaves the
seeded PNGs in place instead of regenerating them.

## Demo fixtures

`gaggiuino-local-profiler/scripts/demo-fixtures.mts` records a static snapshot of every API
response the SPA needs, so the demo can later be served from GitHub Pages with a service worker
instead of the Go backend (#1193). Run it from `gaggiuino-local-profiler/`:

```sh
npm run demo:fixtures
```

It boots the same throwaway server as the screenshots, restores the sanitized
`demo/glp-demo-backup.zip` (override with `GLP_DEMO_BACKUP=/path/to/backup.zip`), places a few
pending orders so the Orders view is not empty, and then drives headless Chromium through every
view at desktop and phone width. Anything the SPA did not request is filled in from the GET
operations in `go/internal/system/openapi.yaml`. The result goes to `demo/fixtures/`: a
`manifest.json` plus one file per response. That directory is git-ignored — it is a regenerated
artifact, not source. Before writing anything the script scans every text response for leaked
personal data (IP literals, e-mail addresses, long hex blobs) and aborts on a hit, so a run that
passes is safe to serve but never committed. Like `screenshots.mts` it needs
`npx playwright install chromium` once.

## Performance comparison

The manually triggered `perf-compare` GitHub Actions workflow measures the same
workload against two images — a base ref (for example the previous release tag)
and a head ref (the release candidate) — runs them one after the other on the
same runner, and writes a Markdown table. It only runs in GitHub Actions, never
on a local machine, and it is not a pull-request gate; it feeds the release
acceptance pass (#1558). Deployment begins when the workflow lands; this section
documents the scripts it drives.

The three Node scripts it runs can also be called by hand from
`gaggiuino-local-profiler/`:

```sh
npm run perf:dataset -- --shots 5000 --out /tmp/dataset.zip
npm run perf:measure -- --base-url http://127.0.0.1:8099 --ref v3.5.0 --out /tmp/head.json
npm run perf:compare -- /tmp/base.json /tmp/head.json
```

`perf:dataset` grows `demo/glp-demo-backup.zip` to the requested shot count with
a seeded generator (default 5000 shots, seed 1558), so the same input and seed
give a byte-identical ZIP. `perf:measure` optionally restores that ZIP
(`--restore <zip>`) and times the shot list, a shot detail with its curve, the
full `/shots.json` history the statistics page loads, and the library,
maintenance, achievements and status endpoints, each as median and p95 over
`--runs` runs (default 30, after `--warmup`, default 3). It also measures the
built frontend bundle size: every same-origin script, stylesheet and
modulepreload the index page references, plus the total.

`perf:measure` takes the API token from `--token <value>`, else the environment
variable `GLP_PERF_TOKEN`, and otherwise fetches `GET /api/token`. When GLP runs
as a plain Docker container outside Home Assistant that endpoint is refused
(`expose_api_port`), so pass `--token` or `GLP_PERF_TOKEN`; the token is sent as
`x-glp-token` on every request, including `POST /api/restore`.

The workflow merges its own container metrics (startup time, idle RSS/CPU, peak
RSS and image size), measured outside Node, into the same JSON with `jq`. Every
metric has one shape:
`{ "value": number, "unit": "ms" | "bytes" | "%", "better": "lower" | "higher" }`.

`perf:compare` prints `Metric | Base | Head | Change (%)`. A row whose change is
worse than `--threshold` percent (default 15) in the metric's `better` direction
is marked `review`; a metric present in only one file is listed with `n/a`. The
command always exits 0 — a regression is a review item, not a failure.

Lighthouse is deliberately not measured: its run-to-run noise on CI runners is
well above the 10 % the issue asks for, so a 15 % threshold could not tell a
real regression from noise. Bundle size and the API timings above cover the
frontend instead.

## Versioning

`MAJOR.MINOR.PATCH` — patch for fixes, minor for new features. `gaggiuino-local-profiler/config.yaml`'s `version:` is canonical; three more spots must be bumped to match it in the same commit: `package.json`, `go/internal/system/version.go` (`glpVersion`) and `go/internal/backup/bundle.go` (`glpVersion`). `test/version-sync.test.ts` and `scripts/release-check.mts` enforce the match.
