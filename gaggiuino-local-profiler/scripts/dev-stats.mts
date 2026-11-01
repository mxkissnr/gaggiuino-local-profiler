#!/usr/bin/env node
// Generates DEVELOPMENT.md: how long the GLP ecosystem has been in
// development and how much of it carries a Claude co-author line, per repo
// and combined. Run on demand (`node scripts/dev-stats.mts`) — not wired into
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
function resolveCompanionDir(relativeDir: string, canonicalDir: string): string {
    return existsSync(path.join(relativeDir, '.git')) ? relativeDir : canonicalDir;
}

// ── Chart rendering (dependency-free inline SVG) ────────────────────────
//
// #1028 dropped @napi-rs/canvas from the dependency set, so these charts
// are hand-rolled as SVG string templates instead — no native module, no
// system-font probing, nothing to install. GitHub renders inline SVG in
// markdown, and every mark/label carries an explicit contrasting fill (never
// currentColor). #1210 dropped the old opaque dark background rect: the SVG
// background is now transparent, and each chart ships as a light and a dark
// variant selected with <picture> + prefers-color-scheme (GitHub's supported
// way — CSS media queries inside an SVG are unreliable in Safari).

const CHART_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// One neobrutalist look for every dev-stats chart (#1800, #1802): a card with
// a thick border and a hard, unblurred offset shadow, flat saturated colours,
// heavy lines and bold labels. `shades` holds per-vendor colours (the first is
// the vendor's base colour; the timeline cycles through the rest per model).
// Light and dark variants are selected with <picture> + prefers-color-scheme.
type Theme = 'light' | 'dark';
type Vendor = 'claude' | 'deepseek' | 'other';

interface ChartPalette {
    card: string;
    ink: string;
    shadow: string;
    grid: string;
    shades: Record<Vendor, string[]>;
}

const CHART_THEMES: Record<Theme, ChartPalette> = {
    light: {
        card: '#fffaf0', ink: '#0b0b0b', shadow: '#0b0b0b', grid: '#d9d2bf',
        shades: { claude: ['#1f5fff', '#6aa8ff', '#0a2a8a', '#00a6c0', '#7a3cff', '#0b7a8c', '#b8a1ff', '#3a3aa8'], deepseek: ['#ff5a1f', '#ffa23a', '#b53a00'], other: ['#6b6b6b', '#9a9a9a', '#3f3f3f'] },
    },
    dark: {
        card: '#16181d', ink: '#f5f1e6', shadow: '#ff7a3d', grid: '#34363d',
        shades: { claude: ['#4d8dff', '#a3c8ff', '#2a55c8', '#2ed3ec', '#a07bff', '#1fa0b8', '#d3c4ff', '#6a6ae0'], deepseek: ['#ff7a3d', '#ffb347', '#d9500f'], other: ['#a8a8a8', '#d0d0d0', '#7d7d7d'] },
    },
};

const CARD_SHADOW = 8;
const CARD_BORDER = 3;

// Opening of every chart: root <svg>, accessible title/desc, the offset shadow
// and the bordered card with its uppercase title. `cardH` is the card's own
// height; the viewBox adds room for the shadow.
function cardSVG(t: ChartPalette, title: string, desc: string | null, cardH: number): { open: string[]; cardW: number } {
    const width = 880, cardW = width - CARD_SHADOW - 4;
    const height = cardH + CARD_SHADOW + 4;
    return {
        cardW,
        open: [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="${CHART_FONT_STACK}" role="img" aria-labelledby="t d">`,
            `<title id="t">${xmlEsc(title)}</title>`,
            `<desc id="d">${xmlEsc(desc ?? title)}</desc>`,
            `<rect x="${4 + CARD_SHADOW}" y="${4 + CARD_SHADOW}" width="${cardW}" height="${cardH}" fill="${t.shadow}"/>`,
            `<rect x="5.5" y="5.5" width="${cardW}" height="${cardH}" fill="${t.card}" stroke="${t.ink}" stroke-width="${CARD_BORDER}"/>`,
            `<text x="26" y="40" fill="${t.ink}" font-weight="800" font-size="19" letter-spacing="0.5">${xmlEsc(title.toUpperCase())}</text>`,
        ],
    };
}

const VENDOR_ORDER: readonly Vendor[] = ['claude', 'deepseek', 'other'];
const VENDOR_LABELS: Record<Vendor, string> = { claude: 'Claude', deepseek: 'DeepSeek', other: 'Other' };

// Vendor a model co-author string belongs to (#1210). The two named vendors
// get their own palette colour; anything else is neutral grey.
export function modelVendor(model: string): Vendor {
    if (/^Claude/i.test(model)) return 'claude';
    if (/^DeepSeek/i.test(model)) return 'deepseek';
    return 'other';
}

// #1210: a co-author line with no model version records only the bare
// `Claude` key — display it as "Claude (version not recorded)" so the chart
// and the table don't imply a specific Claude model. The counting key is
// unchanged; only the display string differs.
export function modelDisplayLabel(model: string): string {
    return model === 'Claude' ? 'Claude (version not recorded)' : model;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function xmlEsc(value: string): string {
    return value.replace(/[&<>"]/g, c => XML_ESCAPES[c] ?? c);
}

const BAR_CHART_BAR_H = 24;
const BAR_CHART_GAP = 14;
const BAR_CHART_BOTTOM_PAD = 26;

export interface BarChartItem {
    label: string;
    value: number;
    color?: string;
}

export interface BarChartLegendEntry {
    label: string;
    color: string;
}

// Horizontal bar chart as an SVG document string in the shared card style:
// flat bars with a heavy ink outline growing from a heavy baseline, bold
// category label to the left and bold value at the tip. The viewBox is a fixed
// 880 wide (≈ GitHub's markdown content width, so text renders ~1:1 on desktop
// and scales down on mobile); the root <svg> has role="img" plus <title>/<desc>
// for assistive tech. `legend` renders a swatch row under the title. Returns
// null for an empty series.
export function barChartSVG(
    title: string,
    items: BarChartItem[],
    { theme = 'light', legend = null }: { theme?: Theme; legend?: BarChartLegendEntry[] | null } = {},
): string | null {
    if (!items.length) return null;
    const t = CHART_THEMES[theme] || CHART_THEMES.light;
    const barH = BAR_CHART_BAR_H, gap = BAR_CHART_GAP, leftPad = 236, rightPad = 70;
    const topPad = legend && legend.length ? 98 : 72;
    const barsH = items.length * (barH + gap) - gap;
    const cardH = topPad + barsH + BAR_CHART_BOTTOM_PAD;
    const { open, cardW } = cardSVG(t, title, `Bar chart: ${items.map(i => `${i.label} ${i.value}`).join(', ')}.`, cardH);
    const maxVal = Math.max(...items.map(i => i.value), 1);
    const chartW = cardW - leftPad - rightPad;
    const text = (extra: string) => `fill="${t.ink}" font-weight="800" ${extra}`;
    const parts = [...open];

    if (legend && legend.length) {
        let lx = 26;
        for (const entry of legend) {
            parts.push(
                `<rect x="${lx}" y="58" width="12" height="12" fill="${entry.color}" stroke="${t.ink}" stroke-width="2"/>`,
                `<text x="${lx + 20}" y="69" ${text('font-size="12"')}>${xmlEsc(entry.label)}</text>`,
            );
            lx += 20 + entry.label.length * 7 + 22;
        }
    }

    parts.push(`<line x1="${leftPad}" y1="${topPad - 8}" x2="${leftPad}" y2="${topPad + barsH + 8}" stroke="${t.ink}" stroke-width="3"/>`);
    items.forEach((item, i) => {
        const y = topPad + i * (barH + gap);
        const barW = Math.max(4, Math.round((item.value / maxVal) * chartW));
        const color = item.color || t.shades.claude[0]!;
        const mid = y + barH / 2 + 4;
        parts.push(
            `<text x="${leftPad - 14}" y="${mid}" ${text('font-size="13" text-anchor="end"')}>${xmlEsc(item.label)}</text>`,
            `<rect x="${leftPad + 1.5}" y="${y}" width="${barW}" height="${barH}" fill="${color}" stroke="${t.ink}" stroke-width="3"/>`,
            `<text x="${leftPad + barW + 12}" y="${mid}" ${text('font-size="14"')}>${item.value}</text>`,
        );
    });

    parts.push('</svg>');
    return parts.join('\n') + '\n';
}

// Vendor colours for the model breakdown plus a legend listing only the
// vendors actually present, in a fixed order so the legend doesn't reshuffle
// with the value sort (#1210).
export function modelBreakdownData(
    counts: Record<string, number>,
    theme: Theme = 'light',
): { items: Required<BarChartItem>[]; legend: BarChartLegendEntry[] } {
    const t = CHART_THEMES[theme] || CHART_THEMES.light;
    const items = Object.entries(counts)
        .map(([model, value]) => ({ label: modelDisplayLabel(model), value, color: t.shades[modelVendor(model)][0]! }))
        .sort((a, b) => b.value - a.value);
    const legend = VENDOR_ORDER
        .filter(vendor => Object.keys(counts).some(model => modelVendor(model) === vendor))
        .map(vendor => ({ label: VENDOR_LABELS[vendor], color: t.shades[vendor][0]! }));
    return { items, legend };
}

export interface AiCommit {
    date: string;
    model: string;
}

export interface MonthlySeries {
    model: string;
    counts: number[];
}

// Calendar month (YYYY-MM) of an ISO date.
export function monthKey(date: string): string {
    return date.slice(0, 7);
}

// Monthly AI commit counts per model (#1800): one bucket per calendar month
// from the first AI commit to the month of `today`; one series per model,
// ordered by total commits (largest first).
export function monthlyModelSeries(
    commits: AiCommit[],
    today: string,
): { months: string[]; series: MonthlySeries[] } | null {
    if (!commits.length) return null;
    const months: string[] = [];
    const end = monthKey(today);
    for (let m = commits.map(c => monthKey(c.date)).sort()[0]!; m <= end;) {
        months.push(m);
        const [y, mo] = m.split('-').map(Number) as [number, number];
        m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    }
    const totals: Record<string, number> = {};
    for (const c of commits) totals[c.model] = (totals[c.model] || 0) + 1;
    const ranked = Object.keys(totals).sort((a, b) => totals[b]! - totals[a]! || a.localeCompare(b));
    const series = ranked.map(model => ({ model, counts: months.map(() => 0) }));
    for (const c of commits) {
        const row = series[ranked.indexOf(c.model)]!;
        const i = months.indexOf(monthKey(c.date));
        if (i >= 0) row.counts[i]!++;
    }
    return { months, series };
}

// Multi-line chart of monthly commits: x = months, y = commits per month, one
// line per model. Colour = vendor shade; dash pattern and marker shape cycle
// per model so lines that overlap near zero can still be told apart. Series
// arrive largest first and are drawn in that order, so small ones end up on
// top. The legend wraps into rows and the card grows to fit.
const DASHES = ['', '10 5', '3 5', '10 4 3 4'];
const MARKERS = ['square', 'circle', 'diamond'] as const;

function markerSVG(shape: (typeof MARKERS)[number], cx: number, cy: number, fill: string, ink: string): string {
    const at = `fill="${fill}" stroke="${ink}" stroke-width="2"`;
    if (shape === 'circle') return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" ${at}/>`;
    if (shape === 'diamond') return `<polygon points="${cx.toFixed(1)},${(cy - 8).toFixed(1)} ${(cx + 8).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(cy + 8).toFixed(1)} ${(cx - 8).toFixed(1)},${cy.toFixed(1)}" ${at}/>`;
    return `<rect x="${(cx - 5).toFixed(1)}" y="${(cy - 5).toFixed(1)}" width="10" height="10" ${at}/>`;
}

export function lineChartSVG(
    title: string,
    data: { months: string[]; series: MonthlySeries[] } | null,
    theme: Theme = 'light',
): string | null {
    if (!data || !data.series.length) return null;
    const t = CHART_THEMES[theme] || CHART_THEMES.light;
    const { months, series } = data;

    const used: Record<Vendor, number> = { claude: 0, deepseek: 0, other: 0 };
    const styled = series.map((s, i) => {
        const vendor = modelVendor(s.model);
        const shades = t.shades[vendor];
        return {
            ...s,
            label: modelDisplayLabel(s.model),
            color: shades[used[vendor]++ % shades.length]!,
            dash: DASHES[i % DASHES.length]!,
            marker: MARKERS[i % MARKERS.length]!,
        };
    });

    // Legend rows first: they decide how tall the card is.
    const cardW = 880 - CARD_SHADOW - 4, legendMaxX = cardW - 20;
    const entryW = (label: string) => 34 + label.length * 7 + 16;
    const legend: { x: number; row: number }[] = [];
    let lx = 26, row = 0;
    for (const s of styled) {
        if (lx + entryW(s.label) > legendMaxX && lx > 26) { lx = 26; row++; }
        legend.push({ x: lx, row });
        lx += entryW(s.label);
    }
    const left = 64, right = 36, top = 66 + (row + 1) * 22 + 14, bottom = 52, plotH = 230;
    const cardH = top + plotH + bottom;
    const plotW = cardW - left - right;
    const peak = Math.max(...series.flatMap(s => s.counts), 1);
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(n => n * 4 >= peak) ?? Math.ceil(peak / 4);
    const yMax = step * 4;
    const x = (i: number) => left + (months.length > 1 ? (i / (months.length - 1)) * plotW : plotW / 2);
    const y = (v: number) => top + plotH - (v / yMax) * plotH;
    const text = (extra: string) => `fill="${t.ink}" font-weight="800" ${extra}`;
    const total = (s: MonthlySeries) => s.counts.reduce((a, b) => a + b, 0);

    const desc = `Line chart of AI commits per month from ${months[0]} to ${months[months.length - 1]} (current month still in progress), one line per model: ${series.map(s => `${modelDisplayLabel(s.model)} (${total(s)} commits)`).join(', ')}.`;
    const parts = [...cardSVG(t, title, desc, cardH).open];
    styled.forEach((s, i) => {
        const { x: ex, row: er } = legend[i]!;
        const ly = 66 + er * 22;
        parts.push(
            `<line x1="${ex}" y1="${ly + 6}" x2="${ex + 24}" y2="${ly + 6}" stroke="${s.color}" stroke-width="4"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`,
            markerSVG(s.marker, ex + 12, ly + 6, s.color, t.ink),
            `<text x="${ex + 32}" y="${ly + 11}" ${text('font-size="12"')}>${xmlEsc(s.label)}</text>`,
        );
    });
    for (let v = 0; v <= yMax; v += step) {
        parts.push(
            `<line x1="${left}" y1="${y(v)}" x2="${left + plotW}" y2="${y(v)}" stroke="${v ? t.grid : t.ink}" stroke-width="${v ? 2 : 3}"/>`,
            `<text x="${left - 10}" y="${y(v) + 4}" ${text('font-size="13" text-anchor="end"')}>${v}</text>`,
        );
    }
    parts.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="${t.ink}" stroke-width="3"/>`);
    let lastLabelX = -Infinity;
    months.forEach((m, i) => {
        parts.push(`<line x1="${x(i)}" y1="${top + plotH}" x2="${x(i)}" y2="${top + plotH + 6}" stroke="${t.ink}" stroke-width="3"/>`);
        if (x(i) - lastLabelX < 48) return;
        lastLabelX = x(i);
        const label = new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
        parts.push(`<text x="${x(i)}" y="${top + plotH + 24}" ${text('font-size="13" text-anchor="middle"')}>${xmlEsc(label)}</text>`);
    });
    parts.push(`<text x="20" y="${top + plotH / 2}" ${text('font-size="12" text-anchor="middle" letter-spacing="0.5"')} transform="rotate(-90 20 ${top + plotH / 2})">COMMITS / MONTH</text>`);
    for (const s of styled) {
        const pts = s.counts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        parts.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="4" stroke-linejoin="miter"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`);
        s.counts.forEach((v, i) => { if (v) parts.push(markerSVG(s.marker, x(i), y(v), s.color, t.ink)); });
    }
    parts.push('</svg>');
    return parts.join('\n') + '\n';
}

// Section divider for README.md / DEVELOPMENT.md (#1802): a slim bordered bar
// with a hard shadow and one block per vendor colour, placed above each `##`
// heading in the same card style as the charts. Decorative; the real heading
// below it keeps the anchor and the document outline.
export function dividerSVG(theme: Theme = 'light'): string {
    const t = CHART_THEMES[theme] || CHART_THEMES.light;
    const w = 868, h = 14;
    const blocks = (['claude', 'deepseek', 'other'] as const).map((v, i) =>
        `<rect x="${5.5 + CARD_BORDER / 2 + i * 44}" y="${5.5 + CARD_BORDER / 2}" width="44" height="${h - CARD_BORDER}" fill="${t.shades[v][0]}"/>`);
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 ${h + CARD_SHADOW + 4}" role="img" aria-label="Section divider">`,
        '<title>Section divider</title>',
        `<rect x="${4 + CARD_SHADOW}" y="${4 + CARD_SHADOW}" width="${w}" height="${h}" fill="${t.shadow}"/>`,
        `<rect x="5.5" y="5.5" width="${w}" height="${h}" fill="${t.card}" stroke="${t.ink}" stroke-width="${CARD_BORDER}"/>`,
        ...blocks,
        '</svg>',
    ].join('\n') + '\n';
}

// <picture> markup that swaps the light chart for the dark one under GitHub's
// dark theme (#1210). Paths are relative to the repo root, where both the
// generated DEVELOPMENT.md and the README sit.
export function chartPictureHTML(base: string, alt: string): string {
    return [
        '<picture>',
        `  <source media="(prefers-color-scheme: dark)" srcset="docs/dev-stats/${base}-dark.svg">`,
        `  <img src="docs/dev-stats/${base}-light.svg" alt="${xmlEsc(alt)}" width="100%">`,
        '</picture>',
    ].join('\n');
}

function renderCharts(results: RepoStats[], combinedModelCounts: Record<string, number>, aiLog: AiCommit[]): boolean {
    const outDir = path.join(appRepoRoot, 'docs', 'dev-stats');
    mkdirSync(outDir, { recursive: true });

    const repoItems = results
        .map(r => ({ label: r.name, value: r.totalCommits }))
        .sort((a, b) => b.value - a.value);

    // #1210: one light and one dark variant per chart; the old single
    // commits-per-repo.svg / model-breakdown.svg are no longer written.
    let rendered = false;
    for (const theme of ['light', 'dark'] as const) {
        const commitsSvg = barChartSVG('Commits per repo', repoItems, { theme });
        if (commitsSvg) {
            writeFileSync(path.join(outDir, `commits-per-repo-${theme}.svg`), commitsSvg);
            rendered = true;
        }
        const { items: modelItems, legend } = modelBreakdownData(combinedModelCounts, theme);
        const modelSvg = barChartSVG('AI model breakdown (by commits)', modelItems, { theme, legend });
        if (modelSvg) {
            writeFileSync(path.join(outDir, `model-breakdown-${theme}.svg`), modelSvg);
            rendered = true;
        }
        writeFileSync(path.join(outDir, `section-divider-${theme}.svg`), dividerSVG(theme));
        const timelineSvg = lineChartSVG('AI commits per month by model', monthlyModelSeries(aiLog, new Date().toISOString().slice(0, 10)), theme);
        if (timelineSvg) {
            writeFileSync(path.join(outDir, `model-timeline-${theme}.svg`), timelineSvg);
            rendered = true;
        }
    }
    return rendered;
}

interface RepoSpec {
    name: string;
    dir: string;
}

interface RepoStats {
    name: string;
    dir: string;
    firstDate: string | undefined;
    lastDate: string | undefined;
    totalCommits: number;
    aiCommits: number;
    modelCounts: Record<string, number>;
    modelCostUsd: Record<string, number>;
    aiLog: AiCommit[];
    totalLines: number;
    aiLines: number;
    devHours: number;
}

const REPOS: RepoSpec[] = [
    { name: 'gaggiuino-local-profiler', dir: appRepoRoot },
    { name: 'glp-integration',          dir: resolveCompanionDir(path.join(projectsRoot, 'glp-integration'), path.join(canonicalProjectsRoot, 'glp-integration')) },
    { name: 'glp-lovelace-card',        dir: resolveCompanionDir(path.join(glpProjectRoot, 'glp-lovelace-card'), path.join(canonicalGlpProjectRoot, 'glp-lovelace-card')) },
    { name: 'glp-order-card',           dir: resolveCompanionDir(path.join(glpProjectRoot, 'glp-order-card'), path.join(canonicalGlpProjectRoot, 'glp-order-card')) },
];

// Flat monthly Claude Pro subscription rate in USD. Change this if the plan
// or its price changes — every cost figure in DEVELOPMENT.md derives from it.
const CLAUDE_PRO_MONTHLY_USD = 20;

// #1769: only co-author names that look like a known AI model count toward the
// AI model breakdown and aiCommits/aiLines. The old exclude-list treated every
// unrecognized name as AI, so human co-authors missing from it (e.g. m471j4)
// showed up in the model table. Patterns are case-insensitive and anchored at
// the start of the name (aiModelInChunk() trims the trailer value first).
const AI_MODEL_PATTERNS: RegExp[] = [
    /^Claude/i,
    /^DeepSeek/i,
    /^GPT/i,
    /^Gemini/i,
    /^Copilot/i,
    /^Codex/i,
    /^Qwen/i,
    /^Kimi/i,
    /^GLM/i,
    /^Big Pickle/i,
    /^GLP-Firma /i,
];
export function isAiCoAuthor(name: string): boolean {
    return AI_MODEL_PATTERNS.some(re => re.test(name));
}

// A commit body can carry more than one Co-Authored-By trailer (e.g. a squash
// merge combining a human's and an AI's lines, or an AI-orchestrator plus the
// model it ran) — return the first one that classifies as an AI model, not just
// the first trailer line. Git and GitHub both write the trailer as
// `Co-authored-by:`, so the match is case-insensitive; otherwise every
// AI-assisted commit counted as human (#1597).
export function aiModelInChunk(chunk: string): string | undefined {
    const coAuthors = [...chunk.matchAll(/Co-Authored-By:\s*([^<\n]+)</gi)].map(m => m[1]!.trim());
    return coAuthors.find(isAiCoAuthor);
}

// #1100: billing-type classification for the cost section. Claude is the maintainer's
// flat-rate Claude Pro subscription (CLAUDE_PRO_MONTHLY_USD above); every
// other model is billed by usage through its own API and has no flat
// subscription cost derivable from git history. An unrecognized future
// model defaults to 'api-billed' — a wrong "it's covered by the
// subscription" assumption is worse than an honest "not tracked yet".
type BillingType = 'subscription' | 'api-billed';
const BILLING_TYPE_PATTERNS: { pattern: RegExp; type: BillingType }[] = [
    { pattern: /Claude/i, type: 'subscription' },
    { pattern: /DeepSeek/i, type: 'api-billed' },
];
export function billingTypeFor(model: string): BillingType {
    for (const { pattern, type } of BILLING_TYPE_PATTERNS) {
        if (pattern.test(model)) return type;
    }
    return 'api-billed';
}

// Commits within this many hours of each other are treated as part of the
// same continuous working session. Raise it to merge more commits into fewer,
// longer sessions (higher hours total); lower it to split sessions more
// aggressively (lower hours total).
const SESSION_GAP_HOURS = 2;

// Added to each session's (last − first commit) span, since the first commit
// marks the *end* of some unlogged lead-in work, not the start. Raise it to
// increase every session's duration (higher hours total).
const SESSION_LEAD_IN_MINUTES = 30;

function git(dir: string, args: string): string {
    // maxBuffer bumped from Node's 1 MB default (#823-era commits have
    // unusually long bodies; `git log --shortstat` across all repos now
    // exceeds it and fails with ENOBUFS on some sandboxes).
    return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
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
export function historyScope(
    dir: string,
    runGit: (dir: string, args: string) => string = git,
): '--remotes=origin' | 'HEAD' {
    try {
        const refs = runGit(dir, 'for-each-ref --count=1 refs/remotes/origin');
        if (refs) return '--remotes=origin';
    } catch (err) {
        // A repo without origin refs returns empty output rather than failing, so
        // an actual throw means something else broke. Say so instead of silently
        // publishing branch-dependent numbers — that silence is what hid #529.
        const detail = err instanceof Error ? err.message : 'unexpected non-Error thrown';
        console.warn(`dev-stats: could not read origin refs in ${dir}, falling back to HEAD (numbers will depend on the checked-out branch): ${detail}`);
    }
    return 'HEAD';
}

// Whole calendar months from firstDateStr's month through today's month,
// inclusive — a subscription started any day in a month, or still running
// into a month it's barely touched, still counts that whole month (e.g. a
// first commit on Jan 15 with today Feb 3 is 2 months, not 1).
export function monthsSinceStart(firstDateStr: string | null | undefined, today: Date = new Date()): number {
    if (!firstDateStr) return 0;
    const first = new Date(firstDateStr);
    return (today.getFullYear() - first.getFullYear()) * 12 + (today.getMonth() - first.getMonth()) + 1;
}

// git-hours-style session clustering: commits within SESSION_GAP_HOURS of
// each other belong to the same working session; each session's duration is
// its own span (last − first commit in the cluster) plus one
// SESSION_LEAD_IN_MINUTES credit, since the first commit marks the *end* of
// some unlogged work, not the start. Returns total hours across all sessions.
export function clusterIntoSessions(timestampsMs: number[]): number {
    if (!timestampsMs.length) return 0;
    const sorted = [...timestampsMs].sort((a, b) => a - b);
    const gapMs    = SESSION_GAP_HOURS * 60 * 60 * 1000;
    const leadInMs = SESSION_LEAD_IN_MINUTES * 60 * 1000;

    let totalMs = 0;
    let sessionStart = sorted[0]!;
    let sessionEnd    = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
        const t = sorted[i]!;
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

function statsForRepo(repo: RepoSpec): RepoStats | null {
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
    const raw    = git(repo.dir, `log ${scope} --format=%x02%ad%x01%B --date=short --shortstat`);
    const chunks = raw.split('\x02').filter(Boolean);

    const modelCounts: Record<string, number> = {};
    const modelCostUsd: Record<string, number> = {};
    const aiLog: AiCommit[] = [];
    let aiCommits = 0, totalLines = 0, aiLines = 0;
    for (const chunk of chunks) {
        const ins = parseInt((chunk.match(/(\d+) insertion/) || [])[1] || '0', 10);
        const del = parseInt((chunk.match(/(\d+) deletion/) || [])[1] || '0', 10);
        totalLines += ins + del;
        const model = aiModelInChunk(chunk);
        if (!model) continue;
        aiCommits++;
        aiLines += ins + del;
        aiLog.push({ date: chunk.slice(0, 10), model });
        modelCounts[model] = (modelCounts[model] || 0) + 1;

        // TODO(#1100 follow-up, out of scope here): no commit sets this trailer
        // today, so costUsd is always undefined — a future ppops/OpenHands
        // instrumentation feature is expected to have the DeepSeek coder agent
        // report each session's real API cost, plumbed into commits via this
        // (or a similar) trailer. Once that data exists, this sums it per
        // model instead of leaving api-billed costs untracked below.
        const costMatch = chunk.match(/Co-Authored-Cost-Usd:\s*([0-9.]+)/i);
        const costUsd = costMatch ? parseFloat(costMatch[1]!) : undefined;
        if (costUsd !== undefined) {
            modelCostUsd[model] = (modelCostUsd[model] || 0) + costUsd;
        }
    }

    return { ...repo, firstDate, lastDate, totalCommits, aiCommits, modelCounts, modelCostUsd, aiLog, totalLines, aiLines, devHours };
}

function fmtDate(d: string | null | undefined): string { return d || '?'; }

export function subscriptionCostSentence(monthsCount: number, firstDate: string | null | undefined, costUsd: number): string {
    return `The maintainer pays a flat **$${CLAUDE_PRO_MONTHLY_USD}/month** for Claude Pro, regardless of usage volume — this is the actual subscription cost, not a token-usage estimate. Counting every calendar month touched since the first commit (${fmtDate(firstDate)}), ${monthsCount} month${monthsCount === 1 ? '' : 's'} works out to **$${costUsd.toFixed(2)}** for every Claude-model commit combined, regardless of which Claude model did the work.`;
}

function main(): void {
    const results = REPOS.map(statsForRepo).filter((r): r is RepoStats => r !== null);
    if (!results.length) {
        console.error('No repos found — check the REPOS paths in scripts/dev-stats.mts for this machine\'s layout.');
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
    const combinedModelCounts: Record<string, number> = {};
    results.forEach(r => Object.entries(r.modelCounts).forEach(([m, c]) => {
        combinedModelCounts[m] = (combinedModelCounts[m] || 0) + c;
    }));
    const combinedModelCostUsd: Record<string, number> = {};
    results.forEach(r => Object.entries(r.modelCostUsd).forEach(([m, c]) => {
        combinedModelCostUsd[m] = (combinedModelCostUsd[m] || 0) + c;
    }));

    const days = combined.firstDate && combined.lastDate
        ? Math.round((new Date(combined.lastDate).getTime() - new Date(combined.firstDate).getTime()) / 86400000) + 1
        : null;

    const chartsRendered = renderCharts(results, combinedModelCounts, results.flatMap(r => r.aiLog));

    const monthsSinceStartCount = monthsSinceStart(combined.firstDate);
    const subscriptionCostUsd = monthsSinceStartCount * CLAUDE_PRO_MONTHLY_USD;

    const lines: string[] = [];
    lines.push('# Development Stats');
    lines.push('');
    lines.push(`Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/dev-stats.mts\`. Re-run it any time to refresh these numbers — they are computed live from git history, not hand-maintained.`);
    lines.push('');
    lines.push('## Timeline');
    lines.push('');
    lines.push(`The GLP ecosystem (this app + 3 companion repos) has been in development since **${fmtDate(combined.firstDate)}**` + (days ? ` — **${days} days** as of the last commit (${fmtDate(combined.lastDate)}).` : '.'));
    lines.push('');
    lines.push('| Repo | First commit | Last commit | Commits | AI co-authored |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
        const pct = r.totalCommits ? Math.round(100 * r.aiCommits / r.totalCommits) : 0;
        lines.push(`| ${r.name} | ${fmtDate(r.firstDate)} | ${fmtDate(r.lastDate)} | ${r.totalCommits} | ${r.aiCommits} (${pct}%) |`);
    }
    const combinedPct = combined.totalCommits ? Math.round(100 * combined.aiCommits / combined.totalCommits) : 0;
    lines.push(`| **Combined** | **${fmtDate(combined.firstDate)}** | **${fmtDate(combined.lastDate)}** | **${combined.totalCommits}** | **${combined.aiCommits} (${combinedPct}%)** |`);
    lines.push('');
    if (chartsRendered) { lines.push(chartPictureHTML('commits-per-repo', 'Commits per repo')); lines.push(''); }
    lines.push(`Combined line changes (insertions + deletions across all commits): **${combined.totalLines.toLocaleString()}**, of which **${combined.aiLines.toLocaleString()}** landed in AI-co-authored commits.`);
    lines.push('');
    lines.push('Commits without an AI co-author line are presumed human-only (manual fixes, merges, config tweaks) — not independently verified.');
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
    lines.push('## AI model breakdown (by commit co-author line)');
    lines.push('');
    lines.push('| Model | Commits |');
    lines.push('|---|---|');
    for (const [model, count] of Object.entries(combinedModelCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${modelDisplayLabel(model)} | ${count} |`);
    }
    lines.push('');
    if (chartsRendered) { lines.push(chartPictureHTML('model-breakdown', 'AI model breakdown by commits')); lines.push(''); }
    if (chartsRendered && combined.aiCommits) { lines.push(chartPictureHTML('model-timeline', 'AI commits per month by model')); lines.push(''); }
    lines.push('The exact co-author string varies by era as model names changed over the project\'s lifetime — this table groups by the literal string used in each commit, so the same underlying model released under a new name shows up as a separate row.');
    lines.push('');
    lines.push('## Cost');
    lines.push('');
    lines.push(subscriptionCostSentence(monthsSinceStartCount, combined.firstDate, subscriptionCostUsd));
    lines.push('');
    lines.push('This assumes a continuous subscription for the whole span — it does not account for any gaps where the subscription might have lapsed.');
    lines.push('');
    const apiBilledModels = Object.keys(combinedModelCounts).filter(m => billingTypeFor(m) === 'api-billed');
    if (apiBilledModels.length) {
        const trackedCostUsd = apiBilledModels.reduce((s, m) => s + (combinedModelCostUsd[m] || 0), 0);
        lines.push('| Model | Commits | Cost |');
        lines.push('|---|---|---|');
        for (const m of apiBilledModels.sort((a, b) => (combinedModelCounts[b] ?? 0) - (combinedModelCounts[a] ?? 0))) {
            const cost = combinedModelCostUsd[m];
            lines.push(`| ${m} | ${combinedModelCounts[m] ?? 0} | ${cost !== undefined ? `$${cost.toFixed(2)}` : 'not tracked'} |`);
        }
        lines.push('');
        lines.push(trackedCostUsd
            ? `API-billed models cost **$${trackedCostUsd.toFixed(2)}** tracked so far — this is not a flat rate like Claude Pro, so it only covers commits that carried a \`Co-Authored-Cost-Usd\` trailer.`
            : 'These models are billed per API usage, not a flat subscription, so no dollar figure is derivable from git history alone — no commit yet reports its own cost via a `Co-Authored-Cost-Usd` trailer.');
        lines.push('');
    }
    lines.push('---');
    lines.push('*This file is generated. Do not hand-edit — re-run `node scripts/dev-stats.mts` instead.*');

    const divider = chartPictureHTML('section-divider', 'Section divider');
    const doc = lines.flatMap(l => (chartsRendered && l.startsWith('## ') ? [divider, '', l] : [l]));
    const outPath = path.join(appRepoRoot, 'DEVELOPMENT.md');
    writeFileSync(outPath, doc.join('\n') + '\n');
    console.log(`Wrote ${outPath}`);
}

// Only generate when invoked as a script. Without this guard, merely importing
// anything from this file (e.g. a unit test for historyScope) regenerates and
// overwrites DEVELOPMENT.md as an import side effect — which is how a test run
// could silently republish stats from the wrong branch (#527).
const entryArg = process.argv[1];
const invokedDirectly = entryArg !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(entryArg);
if (invokedDirectly) main();
