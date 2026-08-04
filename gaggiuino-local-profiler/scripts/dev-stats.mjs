#!/usr/bin/env node
// Generates DEVELOPMENT.md: how long the GLP ecosystem has been in
// development and how much of it carries a Claude co-author line, per repo
// and combined. Run on demand (`node scripts/dev-stats.mjs`) — not wired into
// CI, since it assumes the four sibling repos are checked out locally side by
// side, the layout on this machine.
//
// The cost section reports the real Claude Pro subscription cost (a flat
// monthly rate times the number of months since the ecosystem's first
// commit) — not a token/API-billing estimate, since the subscription is
// paid at a flat rate regardless of usage.
//
// The hours-of-development section is a deliberately rough, clearly-labeled
// lower-bound estimate: nobody running this script has access to actual
// session-duration data, only git commit timestamps. It clusters commits
// into sessions by gap and pads each session with a fixed lead-in — see
// clusterIntoSessions() below.

import { execSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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

// Flat monthly Claude Pro subscription rate in USD. Change this if the plan
// or its price changes — every cost figure in DEVELOPMENT.md derives from it.
const CLAUDE_PRO_MONTHLY_USD = 20;

// Commits within this many hours of each other are treated as part of the
// same continuous working session. Raise it to merge more commits into fewer,
// longer sessions (higher hours total); lower it to split sessions more
// aggressively (lower hours total).
const SESSION_GAP_HOURS = 2;

// Added to each session's (last − first commit) span, since the first commit
// marks the *end* of some unlogged lead-in work, not the start. Raise it to
// increase every session's duration (higher hours total).
const SESSION_LEAD_IN_MINUTES = 30;

function git(dir, args) {
    return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' }).trim();
}

// Which history to measure. Workers branch from origin/main, but `dev` carries
// the unreleased work and runs dozens of commits ahead — so measuring the
// checked-out HEAD makes the published figures depend on whose worktree ran the
// script, and a run from main silently *lowers* them (#527, precedent: #523
// rewrote DEVELOPMENT.md from 655 to 619 commits). Measure everything on the
// remote instead: rev-list/log deduplicate across refs, so a commit on both main
// and dev counts once, and --remotes=origin keeps stale local branches out.
// Falls back to HEAD in a clone without origin refs (fresh init, CI shallow).
// No --format here on purpose (#529): git() shells out via /bin/sh, and an
// unquoted %(refname) makes the shell abort with `Syntax error: "(" unexpected`
// before git even runs. The thrown error hit the catch below, which is also the
// legitimate "no origin refs" path — so the scope silently degraded to HEAD and
// #528 never actually took effect. Plain `for-each-ref <pattern>` needs no format
// string: empty output already means "no such refs".
export function historyScope(dir, runGit = git) {
    try {
        const refs = runGit(dir, 'for-each-ref --count=1 refs/remotes/origin');
        if (refs) return '--remotes=origin';
    } catch (err) {
        // A repo without origin refs returns empty output rather than failing, so
        // an actual throw means something else broke. Say so instead of silently
        // publishing branch-dependent numbers — that silence is what hid #529.
        console.warn(`dev-stats: could not read origin refs in ${dir}, falling back to HEAD (numbers will depend on the checked-out branch): ${err.message.split('\n')[0]}`);
    }
    return 'HEAD';
}

// Whole calendar months from firstDateStr's month through today's month,
// inclusive — a subscription started any day in a month, or still running
// into a month it's barely touched, still counts that whole month (e.g. a
// first commit on Jan 15 with today Feb 3 is 2 months, not 1).
export function monthsSinceStart(firstDateStr, today = new Date()) {
    if (!firstDateStr) return 0;
    const first = new Date(firstDateStr);
    return (today.getFullYear() - first.getFullYear()) * 12 + (today.getMonth() - first.getMonth()) + 1;
}

// git-hours-style session clustering: commits within SESSION_GAP_HOURS of
// each other belong to the same working session; each session's duration is
// its own span (last − first commit in the cluster) plus one
// SESSION_LEAD_IN_MINUTES credit, since the first commit marks the *end* of
// some unlogged work, not the start. Returns total hours across all sessions.
export function clusterIntoSessions(timestampsMs) {
    if (!timestampsMs.length) return 0;
    const sorted = [...timestampsMs].sort((a, b) => a - b);
    const gapMs    = SESSION_GAP_HOURS * 60 * 60 * 1000;
    const leadInMs = SESSION_LEAD_IN_MINUTES * 60 * 1000;

    let totalMs = 0;
    let sessionStart = sorted[0];
    let sessionEnd    = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const t = sorted[i];
        if (t - sessionEnd <= gapMs) {
            sessionEnd = t;
        } else {
            totalMs += (sessionEnd - sessionStart) + leadInMs;
            sessionStart = t;
            sessionEnd    = t;
        }
    }
    totalMs += (sessionEnd - sessionStart) + leadInMs;
    return totalMs / 3_600_000;
}

function statsForRepo(repo) {
    if (!existsSync(path.join(repo.dir, '.git'))) {
        console.warn(`skip ${repo.name}: not a git repo at ${repo.dir}`);
        return null;
    }
    // `git log --reverse -1` is a classic trap: -1/--max-count limits the
    // traversal (newest-first) before --reverse flips the display order, so
    // it actually returns the newest commit, not the oldest. Pull the full
    // date list once (newest first) and read both ends instead.
    const scope = historyScope(repo.dir);
    const dates = git(repo.dir, `log ${scope} --format=%ad --date=short`).split('\n').filter(Boolean);
    const lastDate  = dates[0];
    const firstDate = dates[dates.length - 1];
    const totalCommits = parseInt(git(repo.dir, `rev-list --count ${scope}`), 10) || 0;

    const timestampsMs = git(repo.dir, `log ${scope} --format=%at`)
        .split('\n').filter(Boolean).map(s => parseInt(s, 10) * 1000);
    const devHours = clusterIntoSessions(timestampsMs);

    // One bulk call: \x02 marks each commit boundary, followed by the raw
    // commit body, then (thanks to --shortstat) that same commit's diffstat
    // line — so a single split gives us, per commit, both the co-author line
    // and its changed-line count without any per-commit subprocess call.
    const raw    = git(repo.dir, `log ${scope} --format=%x02%B --shortstat`);
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

    return { ...repo, firstDate, lastDate, totalCommits, aiCommits, modelCounts, totalLines, aiLines, devHours };
}

function fmtDate(d) { return d || '?'; }

function main() {
    const results = REPOS.map(statsForRepo).filter(Boolean);
    if (!results.length) {
        console.error('No repos found — check the REPOS paths in scripts/dev-stats.mjs for this machine\'s layout.');
        process.exit(1);
    }

    const combined = {
        firstDate: results.map(r => r.firstDate).sort()[0],
        lastDate: results.map(r => r.lastDate).sort().slice(-1)[0],
        totalCommits: results.reduce((s, r) => s + r.totalCommits, 0),
        aiCommits: results.reduce((s, r) => s + r.aiCommits, 0),
        totalLines: results.reduce((s, r) => s + r.totalLines, 0),
        aiLines: results.reduce((s, r) => s + r.aiLines, 0),
        devHours: results.reduce((s, r) => s + r.devHours, 0),
    };
    const combinedModelCounts = {};
    results.forEach(r => Object.entries(r.modelCounts).forEach(([m, c]) => {
        combinedModelCounts[m] = (combinedModelCounts[m] || 0) + c;
    }));

    const days = combined.firstDate && combined.lastDate
        ? Math.round((new Date(combined.lastDate) - new Date(combined.firstDate)) / 86400000) + 1
        : null;

    const chartsRendered = renderCharts(results, combinedModelCounts);

    const monthsSinceStartCount = monthsSinceStart(combined.firstDate);
    const subscriptionCostUsd = monthsSinceStartCount * CLAUDE_PRO_MONTHLY_USD;

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
    lines.push('## Hours of development (lower-bound estimate)');
    lines.push('');
    lines.push(`Clustering each repo's commit timestamps into working sessions — commits within ${SESSION_GAP_HOURS}h of each other join the same session, and each session gets a ${SESSION_LEAD_IN_MINUTES}-minute lead-in credited ahead of its first commit — gives a combined **${combined.devHours.toFixed(1)} hours** across all four repos.`);
    lines.push('');
    lines.push('| Repo | Hours (session-clustered) |');
    lines.push('|---|---|');
    for (const r of results) {
        lines.push(`| ${r.name} | ${r.devHours.toFixed(1)} |`);
    }
    lines.push(`| **Combined** | **${combined.devHours.toFixed(1)}** |`);
    lines.push('');
    lines.push('This is a **lower-bound estimate derived from git commit timestamps only**, not measured time — it undercounts real work because a long AI-agentic session (orchestration, agent dispatch, review between infrequent commits) can run for hours between commits.');
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
    lines.push('## Claude Pro subscription cost');
    lines.push('');
    lines.push(`Max pays a flat **$${CLAUDE_PRO_MONTHLY_USD}/month** for Claude Pro, regardless of usage volume — this is the actual subscription cost, not a token-usage estimate. ${monthsSinceStartCount} month${monthsSinceStartCount === 1 ? '' : 's'} since the first commit (${fmtDate(combined.firstDate)}) works out to **$${subscriptionCostUsd.toFixed(2)}**.`);
    lines.push('');
    lines.push('This assumes a continuous subscription for the whole span — it does not account for any gaps where the subscription might have lapsed.');
    lines.push('');
    lines.push('---');
    lines.push('*This file is generated. Do not hand-edit — re-run `node scripts/dev-stats.mjs` instead.*');

    const outPath = path.join(appRepoRoot, 'DEVELOPMENT.md');
    writeFileSync(outPath, lines.join('\n') + '\n');
    console.log(`Wrote ${outPath}`);
}

// Only generate when invoked as a script. Without this guard, merely importing
// anything from this file (e.g. a unit test for historyScope) regenerates and
// overwrites DEVELOPMENT.md as an import side effect — which is how a test run
// could silently republish stats from the wrong branch (#527).
const invokedDirectly = process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main();
