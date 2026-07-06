#!/usr/bin/env node
// Generates DEVELOPMENT.md: how long the GLP ecosystem has been in
// development and how much of it carries a Claude co-author line, per repo
// and combined. Run on demand (`node scripts/dev-stats.mjs`) — not wired into
// CI, since it assumes the four sibling repos are checked out locally side by
// side, the layout on this machine.
//
// The cost section is a deliberately rough, clearly-labeled estimate: nobody
// running this script has access to actual per-session token usage, only git
// history. It multiplies changed lines in Claude-co-authored commits by an
// assumed tokens-per-line constant, then by a price table you fill in
// yourself (scripts/dev-stats.pricing.json) — models with no configured
// price are counted as "unpriced" rather than silently treated as free.

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const appRepoRoot = path.join(__dirname, '..', '..');       // .../glp-project/gaggiuino-local-profiler
const glpProjectRoot = path.join(appRepoRoot, '..');         // .../glp-project
const projectsRoot   = path.join(glpProjectRoot, '..');      // .../Projekte

const REPOS = [
    { name: 'gaggiuino-local-profiler', dir: appRepoRoot },
    { name: 'glp-integration',          dir: path.join(projectsRoot, 'glp-integration') },
    { name: 'glp-lovelace-card',        dir: path.join(glpProjectRoot, 'glp-lovelace-card') },
    { name: 'glp-order-card',           dir: path.join(glpProjectRoot, 'glp-order-card') },
];

// Purely illustrative: tokens implied per changed line, including the
// conversation/planning overhead around a diff, not just the diff bytes
// themselves. There is no way to derive this precisely from git alone —
// treat the resulting cost figure as an order-of-magnitude thought
// experiment, not a bill.
const ASSUMED_TOKENS_PER_CHANGED_LINE = 25;

const PRICING_PATH = path.join(__dirname, 'dev-stats.pricing.json');

function git(dir, args) {
    return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' }).trim();
}

function loadPricing() {
    if (!existsSync(PRICING_PATH)) return {};
    try { return JSON.parse(readFileSync(PRICING_PATH, 'utf8')); } catch { return {}; }
}

function savePricing(pricing) {
    const ordered = { _comment: pricing._comment || PRICING_COMMENT, ...Object.fromEntries(
        Object.entries(pricing).filter(([k]) => k !== '_comment').sort()
    ) };
    writeFileSync(PRICING_PATH, JSON.stringify(ordered, null, 2) + '\n');
}

const PRICING_COMMENT =
    'USD per 1,000,000 tokens, blended input/output average — purely illustrative. ' +
    'Fill in your actual plan/API rates for models you want priced; anything left null ' +
    'is treated as "unpriced" and excluded from the cost total (not treated as free).';

function statsForRepo(repo) {
    if (!existsSync(path.join(repo.dir, '.git'))) {
        console.warn(`skip ${repo.name}: not a git repo at ${repo.dir}`);
        return null;
    }
    // `git log --reverse -1` is a classic trap: -1/--max-count limits the
    // traversal (newest-first) before --reverse flips the display order, so
    // it actually returns the newest commit, not the oldest. Pull the full
    // date list once (newest first) and read both ends instead.
    const dates = git(repo.dir, 'log --format=%ad --date=short').split('\n').filter(Boolean);
    const lastDate  = dates[0];
    const firstDate = dates[dates.length - 1];
    const totalCommits = parseInt(git(repo.dir, 'rev-list --count HEAD'), 10) || 0;

    // One bulk call: \x02 marks each commit boundary, followed by the raw
    // commit body, then (thanks to --shortstat) that same commit's diffstat
    // line — so a single split gives us, per commit, both the co-author line
    // and its changed-line count without any per-commit subprocess call.
    const raw    = git(repo.dir, 'log --format=%x02%B --shortstat');
    const chunks = raw.split('\x02').filter(Boolean);

    const modelCounts = {};
    let aiCommits = 0, totalLines = 0, aiLines = 0;
    for (const chunk of chunks) {
        const ins = parseInt((chunk.match(/(\d+) insertion/) || [])[1] || '0', 10);
        const del = parseInt((chunk.match(/(\d+) deletion/) || [])[1] || '0', 10);
        totalLines += ins + del;
        const coAuthor = chunk.match(/Co-Authored-By:\s*(Claude[^<\n]*)</);
        if (!coAuthor) continue;
        aiCommits++;
        aiLines += ins + del;
        const model = coAuthor[1].trim();
        modelCounts[model] = (modelCounts[model] || 0) + 1;
    }

    return { ...repo, firstDate, lastDate, totalCommits, aiCommits, modelCounts, totalLines, aiLines };
}

function fmtDate(d) { return d || '?'; }

function main() {
    const results = REPOS.map(statsForRepo).filter(Boolean);
    if (!results.length) {
        console.error('No repos found — check the REPOS paths in scripts/dev-stats.mjs for this machine\'s layout.');
        process.exit(1);
    }

    const pricing = loadPricing();
    const allModels = new Set();
    results.forEach(r => Object.keys(r.modelCounts).forEach(m => allModels.add(m)));
    let pricingChanged = false;
    for (const model of allModels) {
        if (!(model in pricing)) { pricing[model] = null; pricingChanged = true; }
    }
    if (pricingChanged || !pricing._comment) savePricing(pricing);

    const combined = {
        firstDate: results.map(r => r.firstDate).sort()[0],
        lastDate: results.map(r => r.lastDate).sort().slice(-1)[0],
        totalCommits: results.reduce((s, r) => s + r.totalCommits, 0),
        aiCommits: results.reduce((s, r) => s + r.aiCommits, 0),
        totalLines: results.reduce((s, r) => s + r.totalLines, 0),
        aiLines: results.reduce((s, r) => s + r.aiLines, 0),
    };
    const combinedModelCounts = {};
    results.forEach(r => Object.entries(r.modelCounts).forEach(([m, c]) => {
        combinedModelCounts[m] = (combinedModelCounts[m] || 0) + c;
    }));

    const days = combined.firstDate && combined.lastDate
        ? Math.round((new Date(combined.lastDate) - new Date(combined.firstDate)) / 86400000) + 1
        : null;

    // Cost estimate: only priced models contribute a dollar figure; unpriced
    // models' lines are reported separately so the total is never silently
    // understated.
    let pricedLines = 0, unpricedLines = 0, costUsd = 0;
    for (const r of results) {
        for (const [model, count] of Object.entries(r.modelCounts)) {
            const shareOfAiCommits = r.aiCommits ? count / r.aiCommits : 0;
            const modelLines = Math.round(r.aiLines * shareOfAiCommits);
            const price = pricing[model];
            if (price == null) { unpricedLines += modelLines; continue; }
            pricedLines += modelLines;
            costUsd += (modelLines * ASSUMED_TOKENS_PER_CHANGED_LINE / 1_000_000) * price;
        }
    }

    const lines = [];
    lines.push('# Development Stats');
    lines.push('');
    lines.push(`Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/dev-stats.mjs\`. Re-run it any time to refresh these numbers — they are computed live from git history, not hand-maintained.`);
    lines.push('');
    lines.push('## Timeline');
    lines.push('');
    lines.push(`The GLP ecosystem (this app + 3 companion repos) has been in development since **${fmtDate(combined.firstDate)}**` + (days ? ` — **${days} days** as of the last commit (${fmtDate(combined.lastDate)}).` : '.'));
    lines.push('');
    lines.push('| Repo | First commit | Last commit | Commits | Claude co-authored |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
        const pct = r.totalCommits ? Math.round(100 * r.aiCommits / r.totalCommits) : 0;
        lines.push(`| ${r.name} | ${fmtDate(r.firstDate)} | ${fmtDate(r.lastDate)} | ${r.totalCommits} | ${r.aiCommits} (${pct}%) |`);
    }
    const combinedPct = combined.totalCommits ? Math.round(100 * combined.aiCommits / combined.totalCommits) : 0;
    lines.push(`| **Combined** | **${fmtDate(combined.firstDate)}** | **${fmtDate(combined.lastDate)}** | **${combined.totalCommits}** | **${combined.aiCommits} (${combinedPct}%)** |`);
    lines.push('');
    lines.push(`Combined line changes (insertions + deletions across all commits): **${combined.totalLines.toLocaleString()}**, of which **${combined.aiLines.toLocaleString()}** landed in Claude-co-authored commits.`);
    lines.push('');
    lines.push('Commits without a Claude co-author line are presumed human-only (manual fixes, merges, config tweaks) — not independently verified.');
    lines.push('');
    lines.push('## Claude model breakdown (by commit co-author line)');
    lines.push('');
    lines.push('| Model | Commits |');
    lines.push('|---|---|');
    for (const [model, count] of Object.entries(combinedModelCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${model} | ${count} |`);
    }
    lines.push('');
    lines.push('The exact co-author string varies by era as model names changed over the project\'s lifetime — this table groups by the literal string used in each commit, so the same underlying model released under a new name shows up as a separate row.');
    lines.push('');
    lines.push('## Rough cost estimate (illustrative only — not real billing data)');
    lines.push('');
    lines.push('This is **not** measured token usage or an actual invoice. It multiplies changed lines (insertions + deletions) in Claude-co-authored commits by an assumed ' + ASSUMED_TOKENS_PER_CHANGED_LINE + ' tokens/line (covers the conversation and planning overhead around a diff, not just the diff bytes), then applies the price table in `scripts/dev-stats.pricing.json` — which ships with every price set to `null` until you fill in your own plan/API rates.');
    lines.push('');
    if (pricedLines === 0) {
        lines.push('**Estimated cost: unknown** — no per-token prices are configured in `scripts/dev-stats.pricing.json` yet. Fill in a rate for at least one model to see a figure here.');
    } else {
        lines.push(`**Estimated cost: ~$${costUsd.toFixed(2)}** across ${pricedLines.toLocaleString()} priced lines` + (unpricedLines ? ` (+ ${unpricedLines.toLocaleString()} lines from unpriced models, excluded from this total)` : '') + '.');
    }
    lines.push('');
    lines.push('---');
    lines.push('*This file is generated. Do not hand-edit — re-run `node scripts/dev-stats.mjs` instead.*');

    const outPath = path.join(appRepoRoot, 'DEVELOPMENT.md');
    writeFileSync(outPath, lines.join('\n') + '\n');
    console.log(`Wrote ${outPath}`);
}

main();
