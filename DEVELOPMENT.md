# Development Stats

Generated 2026-07-11 by `scripts/dev-stats.mjs`. Re-run it any time to refresh these numbers — they are computed live from git history, not hand-maintained.

## Timeline

The GLP ecosystem (this app + 3 companion repos) has been in development since **2026-05-20** — **53 days** as of the last commit (2026-07-11).

| Repo | First commit | Last commit | Commits | Claude co-authored |
|---|---|---|---|---|
| gaggiuino-local-profiler | 2026-05-20 | 2026-07-11 | 445 | 350 (79%) |
| glp-integration | 2026-05-22 | 2026-07-10 | 69 | 55 (80%) |
| glp-lovelace-card | 2026-05-24 | 2026-07-10 | 74 | 65 (88%) |
| glp-order-card | 2026-05-25 | 2026-07-10 | 45 | 39 (87%) |
| **Combined** | **2026-05-20** | **2026-07-11** | **633** | **509 (80%)** |

![Commits per repo](docs/dev-stats/commits-per-repo.png)

Combined line changes (insertions + deletions across all commits): **226.744**, of which **171.805** landed in Claude-co-authored commits.

Commits without a Claude co-author line are presumed human-only (manual fixes, merges, config tweaks) — not independently verified.

## Claude model breakdown (by commit co-author line)

| Model | Commits |
|---|---|
| Claude Sonnet 4.6 | 348 |
| Claude Sonnet 5 | 71 |
| Claude Opus 4.8 | 47 |
| Claude Fable 5 | 32 |
| Claude | 11 |

![Claude model breakdown by commits](docs/dev-stats/model-breakdown.png)

The exact co-author string varies by era as model names changed over the project's lifetime — this table groups by the literal string used in each commit, so the same underlying model released under a new name shows up as a separate row.

## Rough cost estimate (illustrative only — not real billing data)

This is **not** measured token usage or an actual invoice. It multiplies changed lines (insertions + deletions) in Claude-co-authored commits by an assumed 25 tokens/line (covers the conversation and planning overhead around a diff, not just the diff bytes), then applies the price table in `scripts/dev-stats.pricing.json` — which ships with every price set to `null` until you fill in your own plan/API rates.

**Estimated cost: ~$28.44** across 167.935 priced lines (+ 3.870 lines from unpriced models, excluded from this total).

---
*This file is generated. Do not hand-edit — re-run `node scripts/dev-stats.mjs` instead.*
