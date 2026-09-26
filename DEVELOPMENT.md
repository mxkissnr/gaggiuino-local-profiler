# Development Stats

Generated 2026-09-26 by `scripts/dev-stats.mjs`. Re-run it any time to refresh these numbers — they are computed live from git history, not hand-maintained.

## Timeline

The GLP ecosystem (this app + 3 companion repos) has been in development since **2026-05-20** — **130 days** as of the last commit (2026-09-26).

| Repo | First commit | Last commit | Commits | AI co-authored |
|---|---|---|---|---|
| gaggiuino-local-profiler | 2026-05-20 | 2026-09-26 | 1660 | 1069 (64%) |
| glp-integration | 2026-05-22 | 2026-09-26 | 180 | 78 (43%) |
| glp-lovelace-card | 2026-05-24 | 2026-09-26 | 166 | 87 (52%) |
| glp-order-card | 2026-05-25 | 2026-09-26 | 130 | 59 (45%) |
| **Combined** | **2026-05-20** | **2026-09-26** | **2136** | **1293 (61%)** |

![Commits per repo](docs/dev-stats/commits-per-repo.svg)

Combined line changes (insertions + deletions across all commits): **566,864**, of which **451,094** landed in AI-co-authored commits.

Commits without an AI co-author line are presumed human-only (manual fixes, merges, config tweaks) — not independently verified.

## Hours of development (lower-bound estimate)

Clustering each repo's commit timestamps into working sessions — commits within 2h of each other join the same session, and each session gets a 30-minute lead-in credited ahead of its first commit — gives a combined **571.3 hours** across all four repos.

| Repo | Hours (session-clustered) |
|---|---|
| gaggiuino-local-profiler | 379.4 |
| glp-integration | 71.7 |
| glp-lovelace-card | 64.8 |
| glp-order-card | 55.4 |
| **Combined** | **571.3** |

This is a **lower-bound estimate derived from git commit timestamps only**, not measured time — it undercounts real work because a long AI-agentic session (orchestration, agent dispatch, review between infrequent commits) can run for hours between commits.

## AI model breakdown (by commit co-author line)

| Model | Commits |
|---|---|
| Claude Sonnet 5 | 624 |
| Claude Sonnet 4.6 | 410 |
| DeepSeek V4.1 Flash | 84 |
| Claude Opus 4.8 | 64 |
| Claude Fable 5 | 48 |
| Claude Opus 5 | 39 |
| Claude | 13 |
| DeepSeek V4 Flash | 8 |
| Claude Haiku 4.5 | 2 |
| Claude Opus 5.5 | 1 |

![AI model breakdown by commits](docs/dev-stats/model-breakdown.svg)

The exact co-author string varies by era as model names changed over the project's lifetime — this table groups by the literal string used in each commit, so the same underlying model released under a new name shows up as a separate row.

## Cost

Max pays a flat **$20/month** for Claude Pro, regardless of usage volume — this is the actual subscription cost, not a token-usage estimate. 5 months since the first commit (2026-05-20) works out to **$100.00** for every Claude-model commit combined, regardless of which Claude model did the work.

This assumes a continuous subscription for the whole span — it does not account for any gaps where the subscription might have lapsed.

| Model | Commits | Cost |
|---|---|---|
| DeepSeek V4.1 Flash | 84 | not tracked |
| DeepSeek V4 Flash | 8 | not tracked |

These models are billed per API usage, not a flat subscription, so no dollar figure is derivable from git history alone — no commit yet reports its own cost via a `Co-Authored-Cost-Usd` trailer.

---
*This file is generated. Do not hand-edit — re-run `node scripts/dev-stats.mjs` instead.*
