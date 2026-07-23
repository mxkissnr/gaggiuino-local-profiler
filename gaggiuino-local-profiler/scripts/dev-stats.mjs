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
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const appRepoRoot = path.join(__dirname, '..', '..');       // .../glp-project/gaggiuino-local-profiler
const glpProjectRoot = path.join(appRepoRoot, '..');         // .../glp-project
const projectsRoot   = path.join(glpProjectRoot, '..');      // .../Projekte

// #469: this script only ever looks at siblings the same way it always has
// (relative to its own location) unless it's being run from somewhere other
// than the canonical checkout — e.g. a release worktree under ~/worktrees/,
// which has no glp-integration/glp-lovelace-card/glp-order-card siblings at
// all. In that case fall back to the fixed checkout layout documented in
// this machine's CLAUDE.md (everything under ~/Dokumente/Projekte/glp-project).
const canonicalProjectsRoot   = path.join(os.homedir(), 'Dokumente', 'Projekte');
const canonicalGlpProjectRoot = path.join(canonicalProjectsRoot, 'glp-project');
function resolveCompanionDir(relativeDir, canonicalDir) {
    return existsSync(path.join(relativeDir, '.git')) ? relativeDir : canonicalDir;
}

// ── Optional chart rendering (@napi-rs/canvas — same optional-dependency
// pattern as lib/card.js: skip charts silently if the native module or system
// fonts aren't available, since this script must keep working headless). ──
const require = createRequire(import.meta.url);
let createCanvas = null;
let chartFont = 'sans-serif';
try {
    const canvasLib = require('@napi-rs/canvas');
    createCanvas = canvasLib.createCanvas;
    const { GlobalFonts } = canvasLib;
    const FONT_CANDIDATES = [
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
    ];
    for (const fp of FONT_CANDIDATES) {
        if (existsSync(fp)) GlobalFonts.registerFromPath(fp);
    }
    let families = [];
    if (GlobalFonts.getFamilies) {
        try {
            const raw = GlobalFonts.getFamilies();
            const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : JSON.stringify(raw));
            families = Array.isArray(parsed) ? parsed.map(f => f.family || f) : [];
        } catch { /* ignore */ }
    }
    chartFont = families.includes('Liberation Sans') ? 'Liberation Sans'
        : families.includes('DejaVu Sans') ? 'DejaVu Sans'
        : 'sans-serif';
} catch {
    createCanvas = null;
}

// Dark-surface chart palette (matches the app's own dark UI / docs/screenshots).
// Categorical hues used in fixed order — see dataviz skill's color-formula.md.
const CHART = {
    surface: '#1a1a19',
    ink: '#ffffff',
    inkSecondary: '#c3c2b7',
    baseline: '#383835',
    colors: ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'],
};

// Horizontal bar chart: thin marks (22px, under the 24px cap), 4px rounded
// data-end at the bar's tip, square at the baseline, value label at the tip,
// category label to the left — see dataviz skill's marks-and-anatomy.md.
function drawHorizontalBarChart(title, items) {
    if (!createCanvas || !items.length) return null;
    const width = 640, barH = 22, gap = 14, topPad = 46, bottomPad = 16, leftPad = 190, rightPad = 60;
    const height = topPad + items.length * (barH + gap) - gap + bottomPad;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = CHART.surface;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = CHART.ink;
    ctx.font = `600 15px "${chartFont}"`;
    ctx.textAlign = 'left';
    ctx.fillText(title, 20, 28);

    const maxVal = Math.max(...items.map(i => i.value), 1);
    const chartW = width - leftPad - rightPad;

    items.forEach((item, i) => {
        const y = topPad + i * (barH + gap);
        const barW = Math.max(2, Math.round((item.value / maxVal) * chartW));
        const r = Math.min(4, barW / 2, barH / 2);
        const color = CHART.colors[i % CHART.colors.length];

        ctx.fillStyle = CHART.inkSecondary;
        ctx.font = `400 13px "${chartFont}"`;
        ctx.textAlign = 'right';
        ctx.fillText(item.label, leftPad - 12, y + barH / 2 + 4);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(leftPad, y);
        ctx.lineTo(leftPad + barW - r, y);
        ctx.arcTo(leftPad + barW, y, leftPad + barW, y + r, r);
        ctx.lineTo(leftPad + barW, y + barH - r);
        ctx.arcTo(leftPad + barW, y + barH, leftPad + barW - r, y + barH, r);
        ctx.lineTo(leftPad, y + barH);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = CHART.ink;
        ctx.font = `600 13px "${chartFont}"`;
        ctx.textAlign = 'left';
        ctx.fillText(String(item.value), leftPad + barW + 10, y + barH / 2 + 4);
    });

    ctx.strokeStyle = CHART.baseline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, topPad - 8);
    ctx.lineTo(leftPad, topPad + items.length * (barH + gap) - gap);
    ctx.stroke();

    return canvas.toBuffer('image/png');
}

function renderCharts(results, combinedModelCounts) {
    if (!createCanvas) {
        console.warn('@napi-rs/canvas unavailable — skipping chart generation');
        return false;
    }
    const outDir = path.join(appRepoRoot, 'docs', 'dev-stats');
    mkdirSync(outDir, { recursive: true });

    const repoItems = results
        .map(r => ({ label: r.name, value: r.totalCommits }))
        .sort((a, b) => b.value - a.value);
    const modelItems = Object.entries(combinedModelCounts)
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);

    const commitsPng = drawHorizontalBarChart('Commits per repo', repoItems);
    if (commitsPng) writeFileSync(path.join(outDir, 'commits-per-repo.png'), commitsPng);
    const modelPng = drawHorizontalBarChart('Claude model breakdown (by commits)', modelItems);
    if (modelPng) writeFileSync(path.join(outDir, 'model-breakdown.png'), modelPng);
    return true;
}

const REPOS = [
    { name: 'gaggiuino-local-profiler', dir: appRepoRoot },
    { name: 'glp-integration',          dir: resolveCompanionDir(path.join(projectsRoot, 'glp-integration'), path.join(canonicalProjectsRoot, 'glp-integration')) },
    { name: 'glp-lovelace-card',        dir: resolveCompanionDir(path.join(glpProjectRoot, 'glp-lovelace-card'), path.join(canonicalGlpProjectRoot, 'glp-lovelace-card')) },
    { name: 'glp-order-card',           dir: resolveCompanionDir(path.join(glpProjectRoot, 'glp-order-card'), path.join(canonicalGlpProjectRoot, 'glp-order-card')) },
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

    const chartsRendered = renderCharts(results, combinedModelCounts);

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
    if (chartsRendered) { lines.push('![Commits per repo](docs/dev-stats/commits-per-repo.png)'); lines.push(''); }
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
    if (chartsRendered) { lines.push('![Claude model breakdown by commits](docs/dev-stats/model-breakdown.png)'); lines.push(''); }
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
