# AGENTS.md — Gaggiuino Local Profiler

Checklist for AI coding agents (Codex, OpenCode, Cursor, Copilot, Gemini, Claude Code and others) and the people who run them. Every pull request has to meet it. The details are in [CONTRIBUTING.md](CONTRIBUTING.md), the design rules in [docs/DESIGN.md](docs/DESIGN.md), and branch and release maintenance in [docs/MAINTAINING.md](docs/MAINTAINING.md).

## Before you write code

- **Issue first.** No pull request without a linked issue, and claim the issue before you build ([Claim before you build](CONTRIBUTING.md#claim-before-you-build)).
- **Target `dev`, never `main`.** `main` is the default branch only because Home Assistant's app store reads it. Use a `feature/*` branch only when the issue names one. `release/*` branches, including the patch lines `release/X.Y.x`, are maintainer-only.
- **GLP is a client of the Gaggiuino machine's WebSocket/REST API only.** No firmware changes, and no Gaggiuino code, JS bundles or other assets in the repository, not even for research. Gaggiuino's firmware is CC-BY-NC 4.0, GLP is GPLv3 and non-commercial; use the name "Gaggiuino" only descriptively ("for Gaggiuino machines").

## While you write code

- **Go and TypeScript only.** The backend is Go, the browser code and the tooling are TypeScript (`.ts`, tooling `.mts`). Do not add `.js`, `.mjs` or `.cjs` files; a test fails on them. Every `innerHTML` assignment takes an `Html` value, never a raw string (ESLint rule `html-sink`).
- **UI text goes through `t()`.** Add every new key to all six language files in `gaggiuino-local-profiler/public-src/i18n/` (`de`, `en`, `es`, `fr`, `it`, `nl`); a test fails when one of them lacks a key.
- **UI changes follow [docs/DESIGN.md](docs/DESIGN.md).**
- **Fetch calls use relative URLs** (no leading `/`), so the app works behind Home Assistant ingress.
- **Implement with tests.** If a setting can be changed in the UI, a test proves that changing it changes behaviour, not only that it saves.
- **English on GitHub:** code, comments, commit messages, issues and PR text. Only `DOCS.de.md` and the translations are in other languages. No real names anywhere.

## What the pull request contains

- **A changelog fragment, never an edit to `CHANGELOG.md`.** One file per PR, `gaggiuino-local-profiler/changelog.d/<issue>.<section>.md`, format in the [fragment README](gaggiuino-local-profiler/changelog.d/README.md). Content: `- **One bold sentence.** Closes #N`, written for users, without file or function names and without a version number. Section: `fixed` only for a real defect, `changed` for a change in behaviour, `added` for a new capability; `removed`, `deprecated` and `security` where they fit. Changes users cannot see (tests, CI, refactoring, contributor docs) need no fragment.
- **No version bump and no change to the in-app whats-new file.** Both happen at release time.
- **Nothing under `docs/screenshots/`.** Those images are regenerated in the release run. Show before/after images of a UI change in the PR description instead.
- **Docs for user-facing changes:** `DOCS.md` and `DOCS.de.md` change together, in the same PR as the code; a new feature also adds a line to the Features list in `README.md`.
- **The PR template, filled in completely:** a Conventional Commits title (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `build:`), `Closes #N` in the body, the checklist, and the AI assistance disclosure (exactly one level ticked plus the "Tools / models used" line). CI blocks the PR until the disclosure is filled in.
- **A `Co-Authored-By:` trailer on every AI-assisted commit**, naming the tool; a Claude trailer names the specific model, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. CI fails when commits carry an AI trailer but the PR discloses `none`.

## Before you open the pull request

In `gaggiuino-local-profiler/`:

    npm ci --ignore-scripts
    npm run lint
    npm run typecheck
    npm test

In `gaggiuino-local-profiler/go/` (the Go tests need the npm install above):

    gofmt -l .
    go vet ./...
    go test ./...

`gofmt -l .` must print nothing. If you changed the API spec (`openapi.yaml`), run `npm run types:api` and commit the regenerated `schema.gen.ts`; CI fails on a difference. A test that newly fails is a stop sign, never noise to explain away.
